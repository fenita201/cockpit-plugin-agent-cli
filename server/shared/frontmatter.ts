import matter from 'gray-matter';

const disabledFrontmatterEngine = () => ({});

const frontmatterOptions = {
  language: 'yaml',
  // Disable JS/JSON frontmatter parsing to avoid executable project content.
  // Mirrors Gatsby's mitigation for gray-matter.
  engines: {
    js: disabledFrontmatterEngine,
    javascript: disabledFrontmatterEngine,
    json: disabledFrontmatterEngine,
  },
};

/** Used by Commands and provider content readers to parse Markdown metadata with executable engines disabled. */
export function parseFrontMatter(content: string) {
  return matter(content, frontmatterOptions);
}
