import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RpcClassifiedError,
  classifyRpcFailure,
  formatClassifiedRpcFailure,
  isRetryableRpcFailure,
  withClassifiedRpcFailure,
} from "../dist/stellar/client.js";

function codedError(code, message = "synthetic failure", extra = {}) {
  const err = new Error(message);
  Object.assign(err, { code, ...extra });
  return err;
}

describe("classifyRpcFailure — DNS category (#802)", () => {
  it("separates non-retryable NXDOMAIN (ENOTFOUND) from retryable transient EAI_AGAIN", () => {
    const nxdomain = new TypeError("fetch failed", {
      cause: codedError("ENOTFOUND", "getaddrinfo ENOTFOUND secret-rpc.internal", {
        syscall: "getaddrinfo",
      }),
    });
    const nxResult = classifyRpcFailure(nxdomain);
    assert.deepEqual(nxResult, {
      category: "dns",
      reasonCode: "dns_not_found",
      retryable: false,
      httpStatus: null,
      summary: "RPC DNS failure (dns_not_found)",
    });
    assert.equal(isRetryableRpcFailure(nxdomain), false);

    const tempDns = new TypeError("fetch failed", {
      cause: codedError("EAI_AGAIN", "getaddrinfo EAI_AGAIN secret-rpc.internal", {
        syscall: "getaddrinfo",
      }),
    });
    const tempResult = classifyRpcFailure(tempDns);
    assert.deepEqual(tempResult, {
      category: "dns",
      reasonCode: "dns_temp_failure",
      retryable: true,
      httpStatus: null,
      summary: "RPC DNS failure (dns_temp_failure)",
    });
    assert.equal(isRetryableRpcFailure(tempDns), true);

    const serverFailDns = codedError("EAI_FAIL", "DNS lookup failed");
    const serverFailResult = classifyRpcFailure(serverFailDns);
    assert.equal(serverFailResult.category, "dns");
    assert.equal(serverFailResult.reasonCode, "dns_lookup_failed");
    assert.equal(serverFailResult.retryable, true);
  });
});

describe("classifyRpcFailure — TLS category (#802)", () => {
  it("classifies expired, untrusted, hostname-mismatched, and protocol TLS errors as non-retryable", () => {
    const expired = new TypeError("fetch failed", {
      cause: codedError("CERT_HAS_EXPIRED", "certificate has expired for secret.internal"),
    });
    assert.deepEqual(classifyRpcFailure(expired), {
      category: "tls",
      reasonCode: "tls_cert_expired",
      retryable: false,
      httpStatus: null,
      summary: "RPC TLS failure (tls_cert_expired)",
    });

    const selfSigned = codedError("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate");
    assert.deepEqual(classifyRpcFailure(selfSigned), {
      category: "tls",
      reasonCode: "tls_cert_untrusted",
      retryable: false,
      httpStatus: null,
      summary: "RPC TLS failure (tls_cert_untrusted)",
    });

    const altname = codedError(
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "Hostname/IP does not match certificate's altnames",
    );
    assert.deepEqual(classifyRpcFailure(altname), {
      category: "tls",
      reasonCode: "tls_hostname_mismatch",
      retryable: false,
      httpStatus: null,
      summary: "RPC TLS failure (tls_hostname_mismatch)",
    });

    const proto = codedError("EPROTO", "SSL routines:ssl3_get_record:wrong version number");
    assert.deepEqual(classifyRpcFailure(proto), {
      category: "tls",
      reasonCode: "tls_protocol_error",
      retryable: false,
      httpStatus: null,
      summary: "RPC TLS failure (tls_protocol_error)",
    });

    // Transient TLS handshake timeout preserves retryability
    const hsTimeout = codedError("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timed out");
    const hsRes = classifyRpcFailure(hsTimeout);
    assert.equal(hsRes.category, "tls");
    assert.equal(hsRes.reasonCode, "tls_handshake_timeout");
    assert.equal(hsRes.retryable, true);
  });
});

describe("classifyRpcFailure — HTTP category (#802)", () => {
  it("preserves HTTP retryability (408, 429, 5xx retryable; 401, 403, 404, 4xx non-retryable)", () => {
    const cases = [
      { status: 401, reasonCode: "http_unauthorized", retryable: false },
      { status: 403, reasonCode: "http_unauthorized", retryable: false },
      { status: 404, reasonCode: "http_not_found", retryable: false },
      { status: 408, reasonCode: "http_request_timeout", retryable: true },
      { status: 422, reasonCode: "http_client_error", retryable: false },
      { status: 429, reasonCode: "http_rate_limited", retryable: true },
      { status: 502, reasonCode: "http_server_error", retryable: true },
      { status: 504, reasonCode: "http_server_error", retryable: true },
    ];

    for (const c of cases) {
      const err = Object.assign(new Error(`Request failed with status code ${c.status}`), {
        response: {
          status: c.status,
          data: { upstreamBody: "untrusted-upstream-detail" },
        },
      });
      const res = classifyRpcFailure(err);
      assert.equal(res.category, "http");
      assert.equal(res.reasonCode, c.reasonCode);
      assert.equal(res.retryable, c.retryable);
      assert.equal(res.httpStatus, c.status);
      assert.equal(res.summary, `RPC HTTP ${c.status} failure (${c.reasonCode})`);
    }
  });
});

describe("classifyRpcFailure — Timeout, Transport & Redaction (#802)", () => {
  it("unwraps AggregateError / nested causes and never leaks URLs, credentials, or response payloads", async () => {
    const sensitiveParam = ["api_key", "=", "do-not-leak-me-999"].join("");
    const rawErr = new AggregateError(
      [
        codedError(
          "ECONNRESET",
          `read ECONNRESET at https://private-node.internal/rpc?${sensitiveParam}`,
        ),
      ],
      `connect failed https://private-node.internal/rpc?${sensitiveParam}`,
    );

    const summary = formatClassifiedRpcFailure(rawErr);
    assert.equal(summary, "RPC TRANSPORT failure (connection_reset)");
    assert.equal(summary.includes("private-node"), false);
    assert.equal(summary.includes("do-not-leak-me-999"), false);

    await assert.rejects(
      () =>
        withClassifiedRpcFailure(async () => {
          throw codedError("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");
        }),
      (err) => {
        assert.ok(err instanceof RpcClassifiedError);
        assert.equal(err.category, "timeout");
        assert.equal(err.reasonCode, "request_timeout");
        assert.equal(err.retryable, true);
        assert.equal(err.httpStatus, null);
        return true;
      },
    );
  });
});
