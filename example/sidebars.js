module.exports = {
  handbook: [
    "intro",
    { type: "category", label: "Guides", link: { type: "doc", id: "guides/overview" }, items: ["guides/install", "guides/operate"] },
    {
      type: "category",
      label: "Reference",
      link: { type: "generated-index", title: "Reference", description: "The numbers behind the handbook." },
      items: ["reference/fields", "reference/limits", "reference/errors"],
    },
  ],
};
