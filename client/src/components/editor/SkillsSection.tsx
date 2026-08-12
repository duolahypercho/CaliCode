import { useCallback, useEffect, useState } from "react";
import { listSkills, setSkillEnabled, type SkillInfo } from "../../lib/extensions";

export interface SkillsSectionProps {
  /** Scopes the list to the open project's skills in addition to global ones. */
  projectSlug?: string;
}

/**
 * Settings panel body listing user-authored skill files (skills-mcp.md §4.3):
 * one toggle row per skill with a scope badge; rows with a parse error render
 * the message and cannot be toggled. Toggling calls `skill_set_enabled` and
 * refetches — enable state lives in ~/.cali/config.yaml, never in the files.
 */
export function SkillsSection({ projectSlug }: SkillsSectionProps) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills(projectSlug));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to list skills.");
    }
  }, [projectSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (skill: SkillInfo) => {
    const key = `${skill.scope}:${skill.name}`;
    setBusyKey(key);
    setError("");
    try {
      await setSkillEnabled(skill.scope, skill.name, !skill.enabled);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to toggle skill.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section aria-label="Skills" className="text-sm">
      <ul className="space-y-2">
        {skills === null ? (
          <li className="rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-sm text-ink-subtle">
            Loading skills…
          </li>
        ) : skills.length === 0 ? (
          <li className="rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-xs leading-[1.7] text-ink-subtle">
            No skills found. Drop markdown files with <span className="text-ink">name</span> and{" "}
            <span className="text-ink">description</span> frontmatter into:
            <div className="mt-1.5 font-mono text-[11px] text-ink">~/.cali/skills/*.md</div>
            <div className="font-mono text-[11px] text-ink">&lt;project&gt;/.cali/skills/*.md</div>
          </li>
        ) : (
          skills.map((skill) => {
            const key = `${skill.scope}:${skill.name}`;
            const inputId = `skill-toggle-${skill.scope}-${skill.name}`;
            return (
              <li key={key} className="rounded-lg border border-line bg-surface-1 px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-strong" title={skill.path}>
                    {skill.name}
                  </span>
                  <span className="shrink-0 rounded border border-line bg-surface-0 px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-ink-subtle">
                    {skill.scope}
                  </span>
                  <input
                    id={inputId}
                    type="checkbox"
                    aria-label={`Enable skill ${skill.name}`}
                    checked={skill.enabled}
                    disabled={Boolean(skill.error) || busyKey === key}
                    onChange={() => void toggle(skill)}
                    className="h-3.5 w-3.5 shrink-0 accent-[var(--line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                {skill.error ? (
                  <p className="mt-1 text-xs text-destructive">{skill.error}</p>
                ) : (
                  <p className="mt-0.5 truncate text-xs text-ink-subtle" title={skill.description}>
                    {skill.description}
                  </p>
                )}
              </li>
            );
          })
        )}
      </ul>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-[11px] leading-[1.55] text-ink-faint">
        Changes apply to new agent sessions. Global skills live in ~/.cali/skills; project skills in the game
        folder&apos;s .cali/skills and shadow global skills of the same name.
      </p>
    </section>
  );
}
