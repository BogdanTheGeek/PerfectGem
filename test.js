'use strict';

import {
   loadSTL,
   loadGCS,
   loadASC,
   loadGEM,
   groupFacetInfo,
   computeFacetNotesSummary,
   groupExternalFacetsForDesign,
   normalizeDesignFacet,
   buildDesignGcsText,
   buildDesignAscText,
   buildDesignGemBuffer,
} from './loaders.js';

// list all files in models folder
import fs from 'fs';
import path from 'path';

function dumpStoneInfo(stone) {
   const summary = computeFacetNotesSummary(stone);
   const groupedSections = groupFacetInfo(stone.facets, summary.gearUsed);
   const sectionOrder = ['PAVILION', 'CROWN', 'OTHER'];
   const result = {};

   for (const sectionName of sectionOrder) {
      const entries = groupedSections.get(sectionName) || [];
      if (!entries.length) continue;
      result[sectionName] = entries.map(entry => {
         return {
            name: entry.name,
            angle: entry.angle.toFixed(2),
            indexes: entry.indexes.join('-'),
            instructions: entry.instructions,
            frosted: entry.frosted,
            d: entry.d.toFixed(4),
         };
      }
      );
   }
   result.summary = summary;
   for (const [key, value] of Object.entries(result.summary)) {
      if (typeof value === 'number' && !Number.isInteger(value)) {
         result.summary[key] = value.toFixed(4);
      }
   }
   return result;
}

function diff(a, b, path = '') {
   for (const [key, value] of Object.entries(a)) {
      const newPath = `${path}.${key}`;
      if (typeof value === 'object' && value !== null) {
         if (diff(value, b[key], newPath)) {
            return true;
         }
      } else {
         if (value !== b[key]) {
            console.log(`${newPath}: ${value} !== ${b[key]}`);
            return true;
         }
      }
   }
   return false;
}

function buildDesignDefinitionFromStone(stone) {
   const gear = Math.max(1, parseInt(stone?.sourceGear, 10) || 96);
   const sourceFacets = Array.isArray(stone?.facets) ? stone.facets : [];
   const facets = groupExternalFacetsForDesign(sourceFacets, gear)
      .map((facet, idx) => normalizeDesignFacet(facet, idx));
   return {
      gear,
      refractiveIndex: Number.isFinite(Number(stone?.refractiveIndex)) ? Number(stone.refractiveIndex) : 1.54,
      facets,
      metadata: {
         title: String(stone?.metadata?.title || ''),
         comments: String(stone?.metadata?.comments || ''),
      },
   };
}

async function loadStoneFromSerializedDefinition(format, definition) {
   if (format === 'gcs') {
      const text = buildDesignGcsText(definition);
      const data = new TextEncoder().encode(text).buffer;
      return loadGCS(data);
   }
   if (format === 'asc') {
      const text = buildDesignAscText(definition);
      const data = new TextEncoder().encode(text).buffer;
      return loadASC(data);
   }
   if (format === 'gem') {
      const data = buildDesignGemBuffer(definition);
      return loadGEM(data);
   }
   throw new Error(`Unsupported serialization format: ${format}`);
}

async function loadStoneFromModelFile(file) {
   const ext = path.extname(file).toLowerCase();
   const filePath = path.join('./models', file);
   const raw = fs.readFileSync(filePath);
   const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
   if (ext === '.stl') return loadSTL(data);
   if (ext === '.gcs') return loadGCS(data);
   if (ext === '.asc') return loadASC(data);
   if (ext === '.gem') return loadGEM(data);
   throw new Error(`Unsupported file type: ${ext}`);
}


async function test() {
   const args = process.argv.slice(2);
   const files = fs.readdirSync('./models');
   let results = {};
   for (const file of files) {
      const stone = await loadStoneFromModelFile(file);
      const info = dumpStoneInfo(stone);
      const jsonPath = path.join('./results', `${path.basename(file)}.json`);
      if (args.includes('--save')) {
         fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
      } else {
         const failures = [];
         // Compare with existing JSON if it exists
         if (!fs.existsSync(jsonPath)) {
            throw new Error(`No existing JSON to compare for ${file}`);
         }
         const existingInfo = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
         if (diff(existingInfo, info)) {
            failures.push('baseline mismatch vs results JSON');
         }

         if (failures.length) {
            results[file] = { passed: false, info, failures };
         } else {
            results[file] = { passed: true, failures: [] };
         }
      }
   }
   if (args.includes('--save')) {
      return;
   }

   const roundtripSourceFile = files.includes('Fata_Morgana.gem')
      ? 'Fata_Morgana.gem'
      : files.find((name) => ['.gem', '.gcs', '.asc'].includes(path.extname(name).toLowerCase()));
   if (!roundtripSourceFile) {
      throw new Error('No supported model file found for roundtrip serializer test.');
   }

   const roundtripSourceStone = await loadStoneFromModelFile(roundtripSourceFile);
   const roundtripSourceInfo = dumpStoneInfo(roundtripSourceStone);
   const roundtripDefinition = buildDesignDefinitionFromStone(roundtripSourceStone);
   for (const format of ['gcs', 'asc', 'gem']) {
      const roundtripStone = await loadStoneFromSerializedDefinition(format, roundtripDefinition);
      const roundtripInfo = dumpStoneInfo(roundtripStone);
      if (diff(roundtripSourceInfo, roundtripInfo, `${roundtripSourceFile}.${format}`)) {
         throw new Error(`Roundtrip mismatch for ${roundtripSourceFile} (${format})`);
      }
   }

   console.log('Test results:');
   for (const [file, result] of Object.entries(results)) {
      if (result.passed) {
         console.log(`${file}: PASSED`);
      } else {
         console.log(`${file}: FAILED`);
         if (Array.isArray(result.failures) && result.failures.length) {
            console.log(`Failures: ${result.failures.join(', ')}`);
         }
         console.log(`Info: ${JSON.stringify(result.info, null, 2)}`);
      }
   }
   const failedCount = Object.values(results).filter(r => !r.passed).length;
   console.log(`Total: ${Object.keys(results).length}, Passed: ${Object.keys(results).length - failedCount}, Failed: ${failedCount}`);

   if (failedCount > 0) {
      process.exit(1);
   }
}

test();

