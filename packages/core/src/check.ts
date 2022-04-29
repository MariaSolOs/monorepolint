/*!
 * Copyright 2019 Palantir Technologies, Inc.
 *
 * Licensed under the MIT license. See LICENSE file in the project root for details.
 *
 */

import { findWorkspaceDir, Host, matchesAnyGlob, nanosecondsToSanity, Table } from "@monorepolint/utils";
import { dirname as pathDirname, resolve as pathResolve } from "path";
import { ResolvedConfig, ResolvedRule } from "./Config";
import { Context } from "./Context";
import { WorkspaceContext } from "./WorkspaceContext";

export async function check(
  resolvedConfig: ResolvedConfig,
  host: Host,
  cwd = process.cwd(),
  paths?: ReadonlyArray<string>,
  reportStats?: boolean
): Promise<boolean> {
  const checkStart = process.hrtime.bigint();
  const workspaceDir = findWorkspaceDir(host, cwd);
  if (workspaceDir === undefined) {
    throw new Error(`Unable to find a workspace from ${cwd}`);
  }

  const workspaceContext = new WorkspaceContext(workspaceDir, resolvedConfig, host);

  // Validate config once
  const checkConfigStart = process.hrtime.bigint();
  for (const ruleConfig of resolvedConfig.rules) {
    ruleConfig.optionsRuntype.check(ruleConfig.options);
  }
  const checkConfigEnd = process.hrtime.bigint();

  let packagesChecked = BigInt(0);
  const stats = {
    perRule: new Map<string, { name: string; totalTime: bigint; executions: bigint }>(),
  };

  if (paths !== undefined) {
    const resolvedPaths = paths.map((p) => pathDirname(pathResolve(p)));

    for (const path of resolvedPaths) {
      if (workspaceDir === path) {
        packagesChecked++;
        await checkPackage(workspaceContext, stats);
      } else {
        packagesChecked++;
        await checkPackage(workspaceContext.createChildContext(path), stats);
      }
    }
  } else if (workspaceDir === cwd) {
    packagesChecked++;
    await checkPackage(workspaceContext, stats);

    for (const packageDir of workspaceContext.getWorkspacePackageDirs()) {
      packagesChecked++;
      await checkPackage(workspaceContext.createChildContext(packageDir), stats);
    }
  } else {
    packagesChecked++;
    await checkPackage(workspaceContext.createChildContext(cwd), stats);
  }
  const checkEnd = process.hrtime.bigint();

  if (reportStats) {
    if (stats.perRule.size > 0 && reportStats) {
      const checkDetailsTable = new Table<[bigint, string, bigint, bigint]>({
        sortColumn: -1,
        showFooter: true,
        showHeader: true,
        title: `Cost per rule type`,
        columns: [
          {
            header: "Duration",
            type: "bigint",
            renderAs: "nanoseconds",
            precision: 3,
            footer: { aggregate: "sum" },
          },
          {
            header: "Rule",
            type: "string",
            alignment: "left",
            footer: "TOTAL",
          },
          { header: "Runs", type: "bigint", footer: { aggregate: "sum" } },
          {
            header: "Dur/Run",
            type: "bigint",
            precision: 3,
            footer: { aggregate: "average" },
          },
        ],
      });

      const results = Array.from(stats.perRule.values()).sort((a, b) => {
        return a.totalTime > b.totalTime ? 1 : -(a.totalTime < b.totalTime);
      });
      for (const result of results) {
        checkDetailsTable.addRow(
          result.totalTime,
          result.name,
          result.executions,
          result.totalTime / result.executions
        );
      }
      checkDetailsTable.print();
    }

    if (matchesAnyGlob.printStats) matchesAnyGlob.printStats();
    if (printIncludesExcludesCosts) printIncludesExcludesCosts();

    if (true) {
      const table = new Table<[string, string]>({
        title: "Random Stats for check()",
        showFooter: false,
        showHeader: false,
        columns: [{ type: "string", alignment: "left" }, { type: "string" }],
      });
      table.addRow("Packages Checked", "" + packagesChecked);
      table.addRow("Config Valiation", nanosecondsToSanity(checkConfigEnd - checkConfigStart, 4));

      // We used to validate config for every package even though its the same
      table.addRow(
        "Old Config Validation",
        nanosecondsToSanity((checkConfigEnd - checkConfigStart) * (packagesChecked - BigInt(1)), 4)
      );

      table.addRow("Total check() time", nanosecondsToSanity(checkEnd - checkStart, 3));
      table.print();
    }

    // This is kinda lame but because we copy the contents of the rule to the resolved rule, all of the same type share the same `printStats`
    // function. So we just have to find one of them.
    const executed = new Set<(...args: any[]) => any>();
    for (const resolvedRule of workspaceContext.resolvedConfig.rules) {
      if (resolvedRule && resolvedRule.printStats && !executed.has(resolvedRule.printStats)) {
        executed.add(resolvedRule.printStats);
        resolvedRule.printStats();
      }
    }
  }

  return !workspaceContext.failed;
}

async function checkPackage(
  context: Context,
  stats: {
    perRule: Map<string, { name: string; totalTime: bigint; executions: bigint }>;
  }
): Promise<void> {
  if (context.resolvedConfig.verbose) {
    // tslint:disable-next-line:no-console
    console.log(`Starting check against ${context.getName()}`);
  }
  for (const ruleConfig of context.resolvedConfig.rules) {
    const ruleName = ruleConfig.name ?? "unknown";
    const data = stats.perRule.get(ruleName) ?? {
      totalTime: BigInt(0),
      executions: BigInt(0),
      name: ruleName,
    };
    stats.perRule.set(ruleConfig.name ?? "unknown", data);
    data.executions++;
    data.totalTime -= process.hrtime.bigint();

    if (shouldSkipPackage(context, ruleConfig)) {
      data.totalTime += process.hrtime.bigint();
      continue;
    }

    // Although check functions can be asynchronous, run them serially to
    // prevent overlapping CLI output.
    await ruleConfig.check(context, ruleConfig.options, { id: ruleConfig.id });
    data.totalTime += process.hrtime.bigint();
  }
  context.finish();
}

let printIncludesExcludesCosts: undefined | (() => void);

printIncludesExcludesCosts = function printIncludesExcludesCostsFunc() {
  const table = new Table<[string, bigint]>({
    title: "Total Includes/Excludes Glob Cost",
    showFooter: false,
    showHeader: false,
    columns: [{ type: "string" }, { type: "bigint", renderAs: "nanoseconds", precision: 3 }],
  });
  table.addRow("includePackages cost:", includesCost);
  table.addRow("excludePackages cost:", excludesCost);
  table.print();
};

let includesCost = BigInt(0);
let excludesCost = BigInt(0);

/**
 *
 * @internal
 * @param context
 * @param ruleConfig
 */
export function shouldSkipPackage(context: Context, ruleConfig: ResolvedRule) {
  // Short circuit the expensive globs
  if (
    !ruleConfig.includeWorkspaceRoot && // run cheaper checks first
    context.getWorkspaceContext() === context
  ) {
    return true;
  }

  excludesCost -= process.hrtime.bigint();
  const exclude =
    ruleConfig.excludePackages !== undefined ? matchesAnyGlob(context.getName(), ruleConfig.excludePackages) : false;
  excludesCost += process.hrtime.bigint();

  if (exclude) return true;

  includesCost -= process.hrtime.bigint();
  const include =
    ruleConfig.includePackages === undefined ? true : matchesAnyGlob(context.getName(), ruleConfig.includePackages);
  includesCost += process.hrtime.bigint();

  if (!include) return true;

  return false;
}
