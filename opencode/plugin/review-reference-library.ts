import { formatReferences, getAsset, getReferences, searchAssets, searchReferences } from "./review-reference-catalog"

export const ReviewReferenceLibrary = async () => ({
  tool: {
    review_reference_search: {
      description: "Search the pinned, normalized, deduplicated review prompt/rule library by query, language, kind, or domain tag.",
      args: {
        query: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        kinds: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      async execute(args: any) {
        const entries = searchReferences(args ?? {})
        return { title: `Review references: ${entries.length}`, output: formatReferences(entries) }
      },
    },
    review_reference_get: {
      description: "Load exact review reference entries by SHA-256 catalog ID.",
      args: { ids: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
      async execute(args: { ids: string[] }) {
        const entries = getReferences(args.ids ?? [])
        return { title: `Review references: ${entries.length}`, output: formatReferences(entries) }
      },
    },
    review_reference_asset_search: {
      description: "Search preserved structured review assets such as JSON manifests, mappings, plugin metadata, and license files.",
      args: { query: { type: "string", minLength: 1 } },
      async execute(args: { query: string }) {
        return { title: "Review reference assets", output: JSON.stringify({ assets: searchAssets(args.query ?? "") }, null, 2) }
      },
    },
    review_reference_asset_get: {
      description: "Read one exact preserved text asset by source ID and repository-relative path.",
      args: { source: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } },
      async execute(args: { source: string; path: string }) {
        const asset = getAsset(args.source, args.path)
        return { title: `${args.source}:${args.path}`, output: JSON.stringify({ provenance: { source: asset.source, repository: asset.repository, commit: asset.commit, license: asset.license, path: asset.path, sha256: asset.sha256 }, content: asset.content }, null, 2) }
      },
    },
  },
})
