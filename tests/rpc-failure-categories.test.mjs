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
  it("separates non-retryable NXDOMAIN from retryable transient DNS failures", () => {
    const nxdomain = new TypeError("fetch failed", {
      cause: codedError("ENOTFOUND", "getaddrinfo ENOTFOUND secret-rpc.internal", {
        syscall: "getaddrinfo",
      }),
    });
    assert.deepEqual(classifyRpcFailure(nxdomain), {
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
    assert.deepEqual(classifyRpcFailure(tempDns), {
      category: "dns",
      reasonCode: "dns_temp_failure",
      retryable: true,
      httpStatus: null,
      summary: "RPC DNS failure (dns_temp_failure)",
    });
    assert.equal(isRetryableRpcFailure(tempDns), true);

    const serverFail = classifyRpcFailure(codedError("EAI_FAIL", "DNS lookup failed"));
    assert.equal(serverFail.category, "dns");
    assert.equal(serverFail.reasonCode, "dns_lookup_failed");
    assert.equal(serverFail.retryable, true);
  });

  it("classifies message-only and lower-case DNS codes without echoing hostnames", () => {
    const result = classifyRpcFailure("getaddrinfo enotfound private-node.internal");
    assert.equal(result.category, "dns");
    assert.equal(result.reasonCode, "dns_not_found");
    assert.equal(result.retryable, false);
    assert.ok(!result.summary.includes("private-node"));
  });
});

describe("classifyRpcFailure — TLS category (#802)", () => {
  it("marks certificate, hostname and protocol errors non-retryable", () => {
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

    assert.equal(
      classifyRpcFailure(codedError("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"))
        .reasonCode,
      "tls_cert_untrusted",
    );
    assert.equal(
      classifyRpcFailure(
        codedError("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate"),
      ).reasonCode,
      "tls_hostname_mismatch",
    );
    const protocol = classifyRpcFailure(
      codedError("EPROTO", "SSL routines:ssl3_get_record:wrong version number"),
    );
    assert.equal(protocol.category, "tls");
    assert.equal(protocol.reasonCode, "tls_protocol_error");
    assert.equal(protocol.retryable, false);
  });

  it("keeps a TLS handshake timeout retryable", () => {
    const result = classifyRpcFailure(
      codedError("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timed out"),
    );
    assert.equal(result.category, "tls");
    assert.equal(result.reasonCode, "tls_handshake_timeout");
    assert.equal(result.retryable, true);
  });
});

describe("classifyRpcFailure — HTTP category (#802)", () => {
  it("preserves HTTP retryability for 408/429/5xx and common 4xx responses", () => {
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
        response: { status: c.status, data: { upstreamBody: "untrusted-upstream-detail" } },
      });
      const result = classifyRpcFailure(err);
      assert.equal(result.category, "http");
      assert.equal(result.reasonCode, c.reasonCode);
      assert.equal(result.retryable, c.retryable);
      assert.equal(result.httpStatus, c.status);
      assert.equal(result.summary, `RPC HTTP ${c.status} failure (${c.reasonCode})`);
    }
  });

  it("classifies an out-of-range status as an unexpected non-retryable HTTP failure", () => {
    const result = classifyRpcFailure({ response: { status: 200 } });
    assert.deepEqual(result, {
      category: "http",
      reasonCode: "http_unexpected_status",
      retryable: false,
      httpStatus: 200,
      summary: "RPC HTTP 200 failure (http_unexpected_status)",
    });
  });
});

describe("classifyRpcFailure — timeout, transport and redaction (#802)", () => {
  it("unwraps AggregateError causes and never leaks URLs, credentials or payloads", async () => {
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
    assert.ok(!summary.includes("private-node"));
    assert.ok(!summary.includes("do-not-leak-me-999"));

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
        assert.equal(err.message, "RPC TIMEOUT failure (request_timeout)");
        return true;
      },
    );
  });

  it("returns the classified value on success and is idempotent on an already-classified error", async () => {
    assert.equal(await withClassifiedRpcFailure(async () => 42), 42);

    const classified = RpcClassifiedError.from(codedError("ECONNREFUSED", "connect refused"));
    assert.equal(classified.category, "transport");
    assert.equal(classified.reasonCode, "connection_refused");
    assert.equal(classified.retryable, true);
    assert.equal(RpcClassifiedError.from(classified), classified);
  });

  it("falls back to a retryable transport error for unknown, cyclic, or deep cause chains", () => {
    const unknown = classifyRpcFailure(new Error("nothing recognisable here"));
    assert.equal(unknown.category, "transport");
    assert.equal(unknown.reasonCode, "transport_error");
    assert.equal(unknown.retryable, true);

    const cyclic = new Error("outer");
    Object.assign(cyclic, { cause: cyclic });
    assert.equal(classifyRpcFailure(cyclic).reasonCode, "transport_error");

    let deep = new Error("leaf");
    for (let i = 0; i < 12; i++) deep = new Error("wrapper", { cause: deep });
    assert.equal(classifyRpcFailure(deep).reasonCode, "transport_error");
  });
});
