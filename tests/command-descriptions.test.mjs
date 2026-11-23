import test from 'node:test';
import assert from 'node:assert';

import { COMMAND_DESCRIPTIONS, SUPPORTED_LOCALES, messagesFor } from '../dist/i18n.js';
import { COMMANDS } from '../dist/bot.js';

const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const MIN_DESCRIPTION_LENGTH = 1;
const MAX_DESCRIPTION_LENGTH = 256;
// Telegram's command menu is plain text: no MarkdownV2 formatting characters.
const FORBIDDEN_CHARS = /[*_`[\]~>#+|{}.!\\]/;

test('COMMAND_DESCRIPTIONS names fit Telegram limits', () => {
  for (const name of Object.keys(COMMAND_DESCRIPTIONS)) {
    assert.match(
      name,
      NAME_PATTERN,
      `Command "${name}" is invalid: Telegram requires 1-32 lowercase letters, digits or underscores`,
    );
  }
});

test('COMMAND_DESCRIPTIONS descriptions fit Telegram limits', () => {
  for (const [name, description] of Object.entries(COMMAND_DESCRIPTIONS)) {
    assert.strictEqual(
      typeof description,
      'string',
      `Command "${name}" has a non-string description`,
    );
    const length = [...description].length;
    assert.ok(
      length >= MIN_DESCRIPTION_LENGTH && length <= MAX_DESCRIPTION_LENGTH,
      `Command "${name}" description must be 1-256 characters, got ${length}`,
    );
  }
});

test('every locale keeps command descriptions plain and within Telegram limits', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const descriptions = messagesFor(locale).commandDescriptions;
    for (const [name, description] of Object.entries(descriptions)) {
      assert.match(name, NAME_PATTERN, `${locale}: invalid command name "${name}"`);
      assert.strictEqual(
        typeof description,
        'string',
        `${locale}: "${name}" has a non-string description`,
      );
      const length = [...description].length;
      assert.ok(
        length >= MIN_DESCRIPTION_LENGTH && length <= MAX_DESCRIPTION_LENGTH,
        `${locale}: "${name}" description must be 1-256 characters, got ${length}`,
      );
      assert.equal(
        FORBIDDEN_CHARS.test(description),
        false,
        `${locale}: "${name}" description contains MarkdownV2 characters: "${description}"`,
      );
    }
  }
});

test('every bot command has a description', () => {
  for (const command of COMMANDS) {
    const name = typeof command === 'string' ? command : command.command;
    assert.ok(
      Object.hasOwn(COMMAND_DESCRIPTIONS, name),
      `Bot command "${name}" is missing a description in COMMAND_DESCRIPTIONS`,
    );
  }
});

test('registered commands expose a non-empty description in every locale', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const descriptions = messagesFor(locale).commandDescriptions;
    for (const { command } of COMMANDS) {
      const description = descriptions[command];
      assert.ok(
        description && description.trim().length > 0,
        `${locale}: command "${command}" has no description`,
      );
    }
  }
});
