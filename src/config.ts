export const config = {
  get apiKey(): string | null {
    return process.env.EMAILENS_API_KEY ?? null;
  },
  get apiUrl(): string {
    // The app host, not the apex: emailens.dev redirects /api/* here, and a
    // redirect to another host drops the Authorization header on the way.
    return process.env.EMAILENS_API_URL ?? "https://app.emailens.dev";
  },
  get isHosted(): boolean {
    return this.apiKey !== null;
  },
};
