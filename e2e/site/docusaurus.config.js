// The end-to-end test's sample site (e2e/plugin.e2e.ts). Every page,
// title and link here is something the test looks for in the PDF, so a
// change here needs the matching change in the test's EXPECTED block.
module.exports = {
  title: "Kestrel Field Manual",
  tagline: "How the field station runs, in one PDF.",
  url: "https://docs.example.com",
  baseUrl: "/",
  onBrokenLinks: "throw",
  presets: [["classic", { docs: { sidebarPath: "./sidebars.js", routeBasePath: "/" }, blog: false, pages: false }]],
  plugins: [
    [
      require.resolve("../../dist/index.js"),
      {
        filename: "manual.pdf",
        page: { size: "A4" },
        // The test names the API; a build without LEGIVEL_API_URL stops instead of reaching one by chance.
        apiUrl: process.env.LEGIVEL_API_URL || (() => { throw new Error("set LEGIVEL_API_URL to the API origin"); })(),
      },
    ],
  ],
};
