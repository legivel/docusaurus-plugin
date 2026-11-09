// A small site that exports its docs to a PDF through legivel at build time.
// Build it with LEGIVEL_API_KEY set: `LEGIVEL_API_KEY=lgvl_… npx docusaurus build`.



module.exports = {
  title: "Ardleigh Grid handbook",
  tagline: "How the grid is run, in one PDF.",
  url: "https://docs.example.com",
  baseUrl: "/",
  onBrokenLinks: "warn",
  presets: [["classic", { docs: { sidebarPath: "./sidebars.js" }, blog: false }]],
  plugins: [
    [
      require.resolve("../dist/index.js"),
      {
        filename: "handbook.pdf",
        cover: { subtitle: "Operations handbook, built from the docs" },
        page: { size: "A4", footer: "Ardleigh Grid · handbook" },
        language: "en",
        modules: true,
        pages: true,
        themes: ["light", "dark"],
        apiUrl: process.env.LEGIVEL_API_URL || "https://api.legivel.com",
      },
    ],
  ],
  themeConfig: {
    navbar: { title: "Ardleigh Grid", items: [{ to: "/handbook.pdf", label: "Download the PDF", position: "right", target: "_blank" }] },
  },
};
