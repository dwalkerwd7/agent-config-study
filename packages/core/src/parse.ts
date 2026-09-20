import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import matter from 'gray-matter';
import { parse as parseYamlDoc } from 'yaml';

export class ParseFailure extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${source}: ${message}`);
    this.name = 'ParseFailure';
  }
}

/** JSON with comments and trailing commas, as editors write it. */
export function parseJsonWithComments(text: string, source = '<input>'): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const [first] = errors;
    const code = first ? printParseErrorCode(first.error) : 'unknown error';
    throw new ParseFailure(`${code} at offset ${first?.offset ?? 0}`, source);
  }
  return value;
}

export function parseYaml(text: string, source = '<input>'): unknown {
  try {
    return parseYamlDoc(text);
  } catch (cause) {
    throw new ParseFailure(cause instanceof Error ? cause.message : String(cause), source);
  }
}

export interface FrontmatterDoc {
  data: Record<string, unknown>;
  body: string;
}

/** Splits a Markdown file into YAML frontmatter and body. */
export function parseFrontmatter(text: string, source = '<input>'): FrontmatterDoc {
  try {
    const parsed = matter(text);
    return { data: parsed.data as Record<string, unknown>, body: parsed.content };
  } catch (cause) {
    throw new ParseFailure(cause instanceof Error ? cause.message : String(cause), source);
  }
}
