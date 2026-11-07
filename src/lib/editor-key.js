// SHA-256 of the old local-only editor password. The dev server accepts it only when PUBLISH_PASSWORD is not set in
// .env.local; the deployed site never uses it (it needs the PUBLISH_PASSWORD env var). Public, so treat as weak.
export const PASSWORD_SHA256 = '0656e89093994475d3773a5d1d882546ae24137067ba6eb937cfbd301b98a60a';
