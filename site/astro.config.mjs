import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { BASE, REPO, SITE } from "./site.config.mjs";

export default defineConfig({
  site: SITE,
  base: BASE,
  // The only images are the brand's SVGs, which need no resizing, so the build needs no native image library.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "Depthcue",
      description: "Explanations an agent can write, a person can repair, and both can present.",
      logo: {
        light: "./src/assets/logo.svg",
        dark: "./src/assets/logo-on-dark.svg",
        alt: "Depthcue",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/` },
      customCss: [
        "@fontsource-variable/space-grotesk/wght.css",
        "@fontsource/instrument-serif/400.css",
        "@fontsource/ibm-plex-mono/400.css",
        "./src/styles/tokens.css",
        "./src/styles/palette.css",
        "./src/styles/theme.css",
      ],
      // Every folder under content/docs is a section, so a new guide shows up in the sidebar by being written.
      sidebar: [
        { label: "Start", items: [{ slug: "start" }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
      plugins: [starlightLinksValidator()],
    }),
  ],
});
