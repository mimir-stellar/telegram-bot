import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEvent, USDC_UNIT, formatUsdc } from '../dist/stellar/decode.js';
import { txExplorerUrl, accountExplorerUrl, contractExplorerUrl, explorerNetworkSegment } from '../dist/stellar/client.js';

test('client explorer links use correct network segment', () => {
  const config = { explorerBaseUrl: 'https://stellar.expert/explorer', rpcUrl: 'https://soroban-testnet.stellar.org', networkPassphrase: 'Test SDF Network ; September 2015' };
  assert.equal(explorerNetworkSegment(config), 'testnet');
  assert.equal(txExplorerUrl(config, '123'), 'https://stellar.expert/explorer/testnet/tx/123');
  // Account and contract links only accept full strkeys.
  const account = 'G' + 'A'.repeat(55);
  const contract = 'C' + 'A'.repeat(55);
  assert.equal(accountExplorerUrl(config, account), `https://stellar.expert/explorer/testnet/account/${account}`);
  assert.equal(contractExplorerUrl(config, contract), `https://stellar.expert/explorer/testnet/contract/${contract}`);
  assert.equal(accountExplorerUrl(config, 'G123'), '');
});

test('client explorer links default to testnet for unknown networks', () => {
  const config = { explorerBaseUrl: 'https://stellar.expert/explorer', rpcUrl: 'http://localhost:8000/rpc', networkPassphrase: 'Standalone Network ; February 2017' };
  assert.equal(explorerNetworkSegment(config), 'testnet');
});

test('decodeEvent handles malformed XDR safely without crashing', () => {
  const malformedEvent = {
    type: 'contract',
    ledger: '1000',
    ledgerClosedAt: '2023-01-01T00:00:00Z',
    contractId: 'CMALFORMED',
    id: '001-1',
    pagingToken: '001-1',
    topic: ['AAAAAQAAAAtjbGFpbV9jcmVhdGVkAAAA'],
    value: { _type: 'scvVoid' },
    inSuccessfulContractCall: true
  };
  
  const result = decodeEvent('market', malformedEvent);
  assert.equal(result.payload.name, 'unknown');
});

test('decodeEvent handles completely broken values without throwing', () => {
  const result = decodeEvent('market', {
    type: 'contract',
    topic: ['invalid base64!'],
    value: 'more invalid data'
  });
  assert.equal(result.payload.name, 'unknown');
  assert.ok(result.payload.reason);
});
