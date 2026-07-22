import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import "@/caliber/caliber-hero.css"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div
      data-component="session-new-design"
      class="caliber-hero relative size-full overflow-hidden bg-v2-background-bg-deep"
    >
      <div class="absolute inset-x-0 top-[34%] flex flex-col items-center px-6 text-center">
        <div class="caliber-hero-mark">CALIBER</div>
        <div class="caliber-hero-tag">
          tell me what game you're making — arcade shooters, cozy sims, and big scary bosses alike
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-10 flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>{props.children}</div>
      </div>
    </div>
  )
}
