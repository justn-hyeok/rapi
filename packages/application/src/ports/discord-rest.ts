/** Discord's REST API, authenticated as the bot. */
export interface DiscordRest {
  request<T>(route: string, init?: RequestInit): Promise<T>;
}
