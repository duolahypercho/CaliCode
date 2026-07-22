import type { ComponentProps } from "solid-js"

/** Caliber wordmark — replaces the upstream ghost mark on empty states. */
export function CaliberWordmark(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
      aria-label="Caliber"
    >
      <g opacity="0.6">
        <text
          x="348"
          y="98"
          text-anchor="middle"
          font-family="ui-monospace, 'SF Mono', Menlo, monospace"
          font-weight="800"
          font-size="104"
          letter-spacing="14"
          fill="currentColor"
          opacity="0.16"
        >
          CALIBER
        </text>
        <text
          x="700"
          y="98"
          text-anchor="middle"
          font-family="ui-monospace, 'SF Mono', Menlo, monospace"
          font-weight="800"
          font-size="64"
          fill="currentColor"
          opacity="0.35"
        >
          ◆
        </text>
      </g>
    </svg>
  )
}
