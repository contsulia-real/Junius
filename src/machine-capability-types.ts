import type { DesktopComputerUseService } from "./desktop-computer-use.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import type { CustomMachineCapabilityDefinition } from "./custom-machine-capability.js";
import type {
  MachineCapabilityScope,
} from "./machine-capability-policy.js";

export interface MachineCapabilityStatus {
  readonly key: string;
  readonly scope: MachineCapabilityScope;
  readonly description: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly active: boolean;
  readonly custom: boolean;
  readonly launcher?: {
    readonly executable: string;
    readonly fixedArgs: readonly string[];
  };
  readonly policy: readonly string[];
  readonly definition?:
    CustomMachineCapabilityDefinition;
}

export interface MachineCapabilityServices {
  readonly browser: PlaywrightCliService;
  readonly desktop: DesktopComputerUseService;
}
