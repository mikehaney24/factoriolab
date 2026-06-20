import { Injectable } from '@angular/core';

import { Dataset } from '~/state/settings/dataset';
import { Step } from '~/solver/step';
import { QUALITY_REGEX } from '~/data/schema/quality';
import { notNullish } from '~/utils/nullish';
import { rational } from '~/rational/rational';

import {
  BlueprintInsertPlan,
  IBlueprintData,
  IEntity,
  IIcon,
  getQualityString,
} from './blueprint-types';

export const FACTORIO_2_0_VERSION = 562949956370432; // Factorio 2.0.45.0

@Injectable({
  providedIn: 'root',
})
export class BlueprintService {
  async encodeBlueprintString(blueprintData: IBlueprintData): Promise<string> {
    const jsonString = JSON.stringify(blueprintData);
    const utf8Bytes = new TextEncoder().encode(jsonString);
    
    // Factorio expects zlib (RFC 1950) compression. 
    // CompressionStream('deflate') produces exactly this format in browsers.
    const stream = new Blob([utf8Bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    const compressedBytes = new Uint8Array(compressedBuffer);
    
    // Base64 encode the compressed binary data
    let binaryString = '';
    for (let i = 0; i < compressedBytes.length; i++) {
      binaryString += String.fromCharCode(compressedBytes[i]);
    }
    return '0' + btoa(binaryString);
  }

  async generateBlueprintFromSteps(steps: Step[], data: Dataset): Promise<string> {
    const entities: IEntity[] = [];
    let entity_number = 1;

    let currentY = 0;

    for (const step of steps) {
      if (step.machines == null || step.machines.isZero()) continue;

      const recipeId = step.recipeId;
      const recipeSettings = step.recipeSettings;
      
      if (!recipeId || !recipeSettings || !recipeSettings.machineId) continue;

      const machineIdStr = recipeSettings.machineId;
      const { baseId: machineBaseId, level: machineQualityLevel } = this.parseQualityId(machineIdStr);
      
      const machineRecord = data.machineRecord[machineIdStr];
      const width = machineRecord?.size?.[0] ?? 3;
      const height = machineRecord?.size?.[1] ?? 3;

      const numMachines = Math.ceil(step.machines.toNumber());

      let { baseId: recipeBaseId, level: recipeQualityLevel } = this.parseQualityId(recipeId);

      // Generate items insert plan for modules
      const machineModulesPlan = this.generateInsertPlan(recipeSettings.modules, recipeSettings.machineId);

      // Place machines in a row
      let currentX = 0;
      for (let i = 0; i < numMachines; i++) {
        const entity: IEntity = {
          entity_number: entity_number++,
          name: machineBaseId,
          position: {
            x: currentX + width / 2,
            y: currentY + height / 2,
          },
          recipe: recipeBaseId,
          recipe_quality: getQualityString(recipeQualityLevel),
          quality: getQualityString(machineQualityLevel),
          items: machineModulesPlan,
        };
        entities.push(entity);
        currentX += width + 1; // 1 tile gap
      }

      currentY += height + 1;

      // Handle Beacons
      if (recipeSettings.beacons) {
        for (const beaconSettings of recipeSettings.beacons) {
          if (!beaconSettings.id || !beaconSettings.count || beaconSettings.count.isZero()) continue;

          // Use the calculated total beacons for the step, fallback to count if total is missing
          const numBeacons = Math.ceil((beaconSettings.total ?? beaconSettings.count).toNumber());
          const { baseId: beaconBaseId, level: beaconQualityLevel } = this.parseQualityId(beaconSettings.id);

          const beaconRecord = data.beaconRecord[beaconSettings.id];
          const bWidth = beaconRecord?.size?.[0] ?? 3;
          const bHeight = beaconRecord?.size?.[1] ?? 3;

          const beaconModulesPlan = this.generateInsertPlan(beaconSettings.modules, beaconSettings.id);

          currentX = 0;
          for (let i = 0; i < numBeacons; i++) {
            const entity: IEntity = {
              entity_number: entity_number++,
              name: beaconBaseId,
              position: {
                x: currentX + bWidth / 2,
                y: currentY + bHeight / 2,
              },
              quality: getQualityString(beaconQualityLevel),
              items: beaconModulesPlan,
            };
            entities.push(entity);
            currentX += bWidth + 1;
          }
          currentY += bHeight + 1;
        }
      }
      
      currentY += 1; // Extra gap between steps
    }

    const icons: IIcon[] = [];
    const mainIconItem = steps.find(s => s.output && s.output.gt(rational.zero))?.itemId ?? steps[0]?.itemId;
    if (mainIconItem) {
      const { baseId: iconBaseId } = this.parseQualityId(mainIconItem);
      icons.push({
        index: 1,
        signal: { type: 'item', name: iconBaseId },
      });
    }

    const blueprintData: IBlueprintData = {
      blueprint: {
        version: FACTORIO_2_0_VERSION,
        item: 'blueprint',
        label: 'FactorioLab Export',
        icons,
        entities,
      },
    };

    return this.encodeBlueprintString(blueprintData);
  }

  private parseQualityId(id: string): { baseId: string; level?: number } {
    const match = QUALITY_REGEX.exec(id);
    if (match) {
      return { baseId: match[1], level: parseInt(match[2], 10) };
    }
    return { baseId: id };
  }

  private generateInsertPlan(modules: any[] | undefined, entityId: string): BlueprintInsertPlan[] | undefined {
    if (!modules || modules.length === 0) return undefined;

    // Determine module inventory index based on entity name heuristic
    let inventory = 4; // Default to crafter_modules (assembling-machine, furnace, etc)
    const lowerId = entityId.toLowerCase();
    if (lowerId.includes('beacon')) {
      inventory = 1;
    } else if (lowerId.includes('mining-drill') || lowerId.includes('pumpjack')) {
      inventory = 2;
    } else if (lowerId.includes('lab')) {
      inventory = 3;
    }

    const plan: BlueprintInsertPlan[] = [];
    let currentStack = 0;

    for (const mod of modules) {
      if (!mod.id || !mod.count || mod.count.isZero()) continue;

      const count = Math.ceil(mod.count.toNumber());
      const { baseId: modBaseId, level: modQualityLevel } = this.parseQualityId(mod.id);

      const in_inventory: any[] = [];
      for (let i = 0; i < count; i++) {
        in_inventory.push({
          inventory,
          stack: currentStack++
        });
      }

      plan.push({
        id: {
          name: modBaseId,
          quality: getQualityString(modQualityLevel),
        },
        items: {
          in_inventory
        }
      });
    }

    return plan.length > 0 ? plan : undefined;
  }
}
