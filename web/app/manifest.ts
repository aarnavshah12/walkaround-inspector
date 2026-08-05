import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Walkaround Inspector",
    short_name: "Walkaround",
    description:
      "Record a timestamped walkaround video of a rental car before you drive off. Damage detection and a signed report follow.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0c12",
    theme_color: "#0d0c12",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
