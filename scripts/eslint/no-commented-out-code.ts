// ESLint rule: comments must explain, not hold disabled code (PLAN.md, Code quality: no dead or commented-out code).
import type { Rule } from 'eslint';
import tseslint from 'typescript-eslint';

const DIRECTIVE =
  /^\s*(eslint|@ts-|prettier-ignore|global\s|istanbul|c8\s|v8\s|#region|#endregion|@vite-ignore|<reference)/;
const CODE_PUNCTUATION = /[;{}()=]/;
const PLAIN_EXPRESSIONS = new Set(['Identifier', 'Literal', 'TemplateLiteral']);

interface ParsedStatement {
  type: string;
  expression?: { type: string };
}

// The typescript-eslint parser, typed for the one call this rule makes.
const parseForESLint = tseslint.parser.parseForESLint as (
  code: string,
  options: { ecmaVersion: 'latest'; sourceType: 'module' },
) => { ast: { body: ParsedStatement[] } };

/** Whether a comment's text parses as code that does something (not a lone word or value). */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || DIRECTIVE.test(trimmed) || !CODE_PUNCTUATION.test(trimmed)) return false;
  let body: ParsedStatement[];
  try {
    body = parseForESLint(trimmed, { ecmaVersion: 'latest', sourceType: 'module' }).ast.body;
  } catch (error) {
    // Only a syntax error means "prose"; anything else is a bug in this rule and must surface.
    if (error instanceof SyntaxError || (error as { name?: string }).name === 'TSError') return false;
    throw error;
  }
  return body.some(
    (node) =>
      node.type !== 'EmptyStatement' &&
      !(node.type === 'ExpressionStatement' && node.expression && PLAIN_EXPRESSIONS.has(node.expression.type)),
  );
}

interface CommentGroup {
  text: string;
  endLine: number;
  loc: { start: { line: number; column: number }; end: { line: number; column: number } };
  isLine: boolean;
}

export const noCommentedOutCode: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow commented-out code' },
    messages: { commentedOutCode: 'Remove commented-out code; git history keeps it.' },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const groups: CommentGroup[] = [];
        for (const comment of context.sourceCode.getAllComments()) {
          if (!comment.loc || (comment.type === 'Block' && comment.value.startsWith('*'))) continue;
          const previous = groups.at(-1);
          const isLine = comment.type === 'Line';
          if (isLine && previous?.isLine && previous.endLine === comment.loc.start.line - 1) {
            previous.text += `\n${comment.value}`;
            previous.endLine = comment.loc.end.line;
            previous.loc.end = comment.loc.end;
          } else {
            groups.push({
              text: comment.value,
              endLine: comment.loc.end.line,
              loc: { start: comment.loc.start, end: comment.loc.end },
              isLine,
            });
          }
        }
        for (const group of groups) {
          if (looksLikeCode(group.text)) context.report({ loc: group.loc, messageId: 'commentedOutCode' });
        }
      },
    };
  },
};
