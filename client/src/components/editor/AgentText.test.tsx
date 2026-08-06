import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentText } from "./AgentText";

describe("AgentText", () => {
  it("renders bold instead of showing asterisks", () => {
    render(<AgentText content="There are **3** entities." />);
    expect(screen.getByText("3").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("renders inline code", () => {
    render(<AgentText content="Call `editor_run_pie` next." />);
    expect(screen.getByText("editor_run_pie").tagName).toBe("CODE");
  });

  it("keeps line breaks", () => {
    const { container } = render(<AgentText content={"one\ntwo\nthree"} />);
    expect(container.querySelectorAll("br")).toHaveLength(2);
  });

  it("never emits markup from model output", () => {
    // Segments are React text nodes, so angle brackets stay literal.
    const { container } = render(<AgentText content={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img");
  });

  it("leaves unmatched markers alone", () => {
    const { container } = render(<AgentText content="2 ** 3 is not bold" />);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("2 ** 3 is not bold");
  });
});
