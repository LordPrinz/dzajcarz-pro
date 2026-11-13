import type { BotModule } from "@dzajcarz/core";
import { createAreas } from "./areas.ts";
import { createControls } from "./controls.ts";
import { createLimits } from "./limits.ts";
import { createPanel } from "./panel.ts";
import { createSpecialInvites } from "./special-invites.ts";
import type { PartyModuleDeps } from "./types.ts";
import { createVoice } from "./voice.ts";

export { renderChannelName, validateTemplate } from "./naming.ts";
export type * from "./types.ts";

export function createPartyModule(deps: PartyModuleDeps): BotModule {
  const limits = createLimits(deps);
  const controls = createControls(deps, limits);
  const special = createSpecialInvites(deps, limits, controls);
  const panel = createPanel(deps, controls, special);
  const areas = createAreas(deps, limits, controls, special, panel);
  const voice = createVoice(deps, limits, areas);

  return {
    name: "party",
    commands: [areas.party],
    components: [panel.panelButton, panel.panelUserSelect],
    modals: [
      areas.areaModal,
      controls.limitModal,
      controls.renameModal,
      special.specialInviteModal,
    ],
    events: [
      voice.leave,
      voice.join,
      voice.removed,
      voice.reconcile,
      voice.reconcileLate,
      panel.chatMessage,
      panel.panelDeleted,
      panel.panelBulkDeleted,
      panel.panels,
    ],
    dispose: panel.dispose,
  };
}
