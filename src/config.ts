export const config = {
  apiKey: process.env.EMAILENS_API_KEY ?? null,
  apiUrl: process.env.EMAILENS_API_URL ?? "https://emailens.dev",
  get isHosted(): boolean {
    return this.apiKey !== null;
  },
} as const;
