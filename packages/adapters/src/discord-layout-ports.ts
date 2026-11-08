import { readFile } from "node:fs/promises";
import { type DiscordGateway } from "@rapi/application";
import { DiscordHttpGateway } from "./discord-gateway.js";

/** What the layout manager reads: Discord as the bot, and the layout file. */
export function discordLayoutPorts(
  botToken: string,
  layoutFile: string,
): {
  rest: Pick<DiscordGateway, "request">;
  readLayout: () => Promise<string>;
} {
  return {
    rest: new DiscordHttpGateway(botToken),
    readLayout: () => readFile(layoutFile, "utf8"),
  };
}
