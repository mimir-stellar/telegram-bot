import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

export function menuMessage(): string {
  return [
    "📋 *Menu*",
    "",
    "Choose an option below:",
    "• *Status* — view current status",
    "• *Contracts* — list contracts",
    "• *Help* — show help",
  ].join("\n");
}

export function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 Status", callback_data: "status" }],
      [{ text: "📄 Contracts", callback_data: "contracts" }],
      [{ text: "❓ Help", callback_data: "help" }],
    ],
  };
}

export const menuCommand = defineCommand({
  command: "menu",
  chatAllowlist: true,
  handler: async (ctx) => {
    await ctx.reply(menuMessage(), {
      ...TELEGRAM_OPTIONS,
      reply_markup: menuKeyboard(),
    });
  },
});
