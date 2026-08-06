import { Fragment, type ReactNode } from "react";

/** `**bold**`, `` `code` ``, and nothing else. */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

/**
 * Renders the small slice of markdown models actually emit in chat.
 *
 * Agent replies were rendered as raw text, so a model answering "There are
 * **3** entities" showed the asterisks. Full markdown would mean shipping a
 * parser and sanitiser for text that comes straight from a model; bold and
 * inline code cover what shows up in practice, and because every segment is
 * rendered as a React text node there is no HTML injection path.
 */
export function AgentText({ content }: { content: string }) {
  return (
    <>
      {content.split("\n").map((line, lineIndex, lines) => (
        <Fragment key={lineIndex}>
          {renderInline(line)}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </>
  );
}

function renderInline(line: string): ReactNode[] {
  return line.split(INLINE).map((segment, index) => {
    if (segment.startsWith("**") && segment.endsWith("**") && segment.length > 4) {
      return (
        <strong key={index} className="font-bold text-[#e6e6e6]">
          {segment.slice(2, -2)}
        </strong>
      );
    }
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length > 2) {
      return (
        <code key={index} className="rounded bg-white/[0.07] px-1 py-px text-[12px] text-[#dadada]">
          {segment.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={index}>{segment}</Fragment>;
  });
}
