export const config = {
  get apiKey(): string | null {
    return process.env.EMAILENS_API_KEY ?? null;
  },
  get apiUrl(): string {
    return process.env.EMAILENS_API_URL ?? "https://emailens.dev";
  },
  get isHosted(): boolean {
    return this.apiKey !== null;
  },
};
