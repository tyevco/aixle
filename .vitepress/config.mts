// The documentation site: the repository's own Markdown (the README, docs/,
// dogfood/) published as is, plus the generated gallery and the viewer pages.
// Built by .github/workflows/pages.yml on every push to main.
import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Aixle",
  description: "A procedural 3D modelling language for language models, with renders an agent can look at.",
  // The repository root is the source, so relative links between the README, docs/ and dogfood/ work unchanged.
  srcDir: ".",
  srcExclude: ["node_modules/**", "dist/**", "out/**", ".claude/**", "CLAUDE.md", "**/renders/**"],
  rewrites: { "README.md": "index.md" },
  base: process.env.PAGES_BASE ?? "/aixle/",
  lastUpdated: false,
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Language", link: "/docs/language" },
      { text: "Agent guide", link: "/docs/agent-guide" },
      { text: "Reference", link: "/docs/reference" },
      { text: "Gallery", link: "/docs/gallery" },
      { text: "Dogfooding", link: "/dogfood/README" },
    ],
    sidebar: [
      {
        text: "Using it",
        items: [
          { text: "Overview", link: "/" },
          { text: "The language", link: "/docs/language" },
          { text: "Building a model: the agent's loop", link: "/docs/agent-guide" },
          { text: "Reference", link: "/docs/reference" },
          { text: "Design", link: "/docs/design" },
        ],
      },
      { text: "Pictures", items: [{ text: "Gallery", link: "/docs/gallery" }] },
      {
        text: "Dogfooding",
        items: [
          { text: "The exercise", link: "/dogfood/README" },
          { text: "Round 1: park bench", link: "/dogfood/round-1/bench.report" },
          { text: "Round 1: lighthouse", link: "/dogfood/round-1/lighthouse.report" },
          { text: "Round 1: anglepoise lamp", link: "/dogfood/round-1/anglepoise.report" },
          { text: "Round 2: frog", link: "/dogfood/round-2/frog.report" },
          { text: "Round 2: excavator", link: "/dogfood/round-2/excavator.report" },
          { text: "Round 2: market stall", link: "/dogfood/round-2/market.report" },
          { text: "Round 2: trophy", link: "/dogfood/round-2/trophy.report" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/tyevco/aixle" }],
    outline: [2, 3],
    search: { provider: "local" },
  },
  markdown: { lineNumbers: false },
  vite: { publicDir: ".vitepress/public" },
});
