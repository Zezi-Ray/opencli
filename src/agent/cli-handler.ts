/**
 * CLI handler for `opencli operate` command.
 *
 * Bridges the CLI interface to the AgentLoop, handling browser session
 * lifecycle, error formatting, and result rendering.
 */

import chalk from 'chalk';
import { browserSession } from '../runtime.js';
import { ConfigError } from '../errors.js';
import { AgentLoop } from './agent-loop.js';
import { LLMClient } from './llm-client.js';
import { saveTraceAsSkillWithValidation } from './skill-saver.js';
import type { AgentConfig, AgentResult } from './types.js';

export interface RunAgentOptions extends AgentConfig {
  BrowserFactory: new () => any;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  // Validate API key
  if (!process.env.OPENCLI_API_KEY) {
    throw new ConfigError(
      'OPENCLI_API_KEY is not set',
      'export OPENCLI_PROVIDER=anthropic           # or openai\n'
      + 'export OPENCLI_MODEL=sonnet                 # model alias or full ID\n'
      + 'export OPENCLI_API_KEY=sk-ant-...           # your API key',
    );
  }

  // Show model info
  const llmPreview = new LLMClient({ model: opts.model });
  if (opts.verbose) {
    console.log(chalk.dim(`Model: ${llmPreview.getModelDisplay()}`));
  }

  const workspace = opts.workspace ?? `operate:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const result = await browserSession(opts.BrowserFactory, async (page) => {
    const agent = new AgentLoop(page, {
      ...opts,
      workspace,
    });

    const agentResult = await agent.run();

    // Save as skill if requested and successful
    if (opts.saveAs && agentResult.success && agentResult.trace) {
      try {
        const saved = await saveTraceAsSkillWithValidation(agentResult.trace, opts.saveAs, agent.getLLMClient());
        if (opts.verbose) {
          console.log(chalk.green(`  Skill saved: ${saved.path}`));
          console.log(chalk.dim(`  Run with: opencli ${saved.command}`));
        }
      } catch (err) {
        console.error(chalk.yellow(`  Warning: Failed to save skill: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    return agentResult;
  }, { workspace });

  return result;
}

export function renderAgentResult(result: AgentResult, modelDisplay?: string): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(chalk.green('✓ Task completed successfully'));
  } else if (result.status === 'max_steps') {
    lines.push(chalk.yellow('⚠ Task incomplete — reached step limit'));
  } else {
    lines.push(chalk.red('✗ Task failed'));
  }

  if (result.result) {
    lines.push('');
    lines.push(result.result);
  }

  if (result.extractedData !== undefined) {
    lines.push('');
    lines.push(chalk.dim('Extracted data:'));
    lines.push(typeof result.extractedData === 'string'
      ? result.extractedData
      : JSON.stringify(result.extractedData, null, 2));
  }

  // Stats line with model name
  lines.push('');
  const stats = [
    `Steps: ${result.stepsCompleted}`,
    `Tokens: ${result.tokenUsage.input}in/${result.tokenUsage.output}out`,
    `Cost: ~$${result.tokenUsage.estimatedCost.toFixed(4)}`,
  ];
  if (modelDisplay) stats.push(`Model: ${modelDisplay}`);
  lines.push(chalk.dim(stats.join(' | ')));

  return lines.join('\n');
}
