// SHA-256 of the essay editor password. Shared by the editor page (client gate) and the local publish
// endpoint (integrations/local-publish.mjs), which re-checks it server-side before writing anything.
export const PASSWORD_SHA256 = '0656e89093994475d3773a5d1d882546ae24137067ba6eb937cfbd301b98a60a';
