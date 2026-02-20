import { header, section } from '../_shared/setup.js';
import { CausalReasoner, CausalGraphBuilder, createLLMBackend } from '@cogitator-ai/core';

async function main() {
  header('12 — Causal Reasoning');

  const llm = createLLMBackend('google', {
    providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
  });

  const reasoner = new CausalReasoner({
    llmBackend: llm,
    model: 'gemini-2.5-flash',
    config: {
      enableLLMDiscovery: true,
      enableSafetyChecks: true,
    },
  });

  const agentId = 'product-analytics';

  section('1. Building a causal graph (business scenario)');

  const graph = CausalGraphBuilder.create('user-retention-analysis')
    .treatment('redesign', 'UI Redesign')
    .causes('ux-complexity', {
      strength: 0.8,
      confidence: 0.9,
      mechanism: 'new navigation patterns increase cognitive load',
    })
    .causes('page-load-time', {
      strength: 0.6,
      confidence: 0.7,
      mechanism: 'heavier assets and animations',
    })
    .causes('feature-discovery', {
      strength: 0.7,
      confidence: 0.8,
      mechanism: 'reorganized feature hierarchy',
    })

    .variable('ux-complexity', 'UX Complexity')
    .causes('user-frustration', { strength: 0.7, confidence: 0.85 })
    .causes('support-tickets', { strength: 0.5, confidence: 0.7 })

    .variable('page-load-time', 'Page Load Time')
    .causes('bounce-rate', { strength: 0.8, confidence: 0.9 })
    .causes('user-frustration', { strength: 0.4, confidence: 0.6 })

    .variable('feature-discovery', 'Feature Discovery')
    .prevents('engagement', {
      strength: 0.6,
      confidence: 0.7,
      mechanism: 'users cant find features they used to use',
    })

    .variable('user-frustration', 'User Frustration')
    .causes('churn', { strength: 0.9, confidence: 0.95 })
    .causes('negative-reviews', { strength: 0.6, confidence: 0.7 })

    .variable('bounce-rate', 'Bounce Rate')
    .causes('churn', { strength: 0.5, confidence: 0.8 })

    .outcome('churn', 'User Churn')
    .outcome('engagement', 'User Engagement')
    .outcome('support-tickets', 'Support Tickets')
    .outcome('negative-reviews', 'Negative Reviews')

    .confounder('seasonality', 'Seasonality')
    .confounds('churn', { strength: 0.3, confidence: 0.5 })
    .confounds('engagement', { strength: 0.3, confidence: 0.5 })

    .build();

  console.log(`  Graph: ${graph.name}`);
  console.log(`  Nodes: ${graph.getNodes().length}`);
  console.log(`  Edges: ${graph.getEdges().length}`);
  console.log();

  for (const node of graph.getNodes()) {
    const children = graph.getChildren(node.id);
    const parents = graph.getParents(node.id);
    console.log(`  [${node.variableType}] ${node.name} (${node.id})`);
    if (parents.length > 0) console.log(`    <- ${parents.map((p) => p.id).join(', ')}`);
    if (children.length > 0) console.log(`    -> ${children.map((c) => c.id).join(', ')}`);
  }

  section('2. Predicting effects of an intervention');

  const prediction = await reasoner.predictEffect(
    'Roll back the UI redesign to the previous version',
    agentId,
    {
      observedVariables: {
        churn: 0.15,
        engagement: 0.45,
        'support-tickets': 250,
        'bounce-rate': 0.35,
      },
    }
  );

  console.log(`  Action: ${prediction.action}`);
  console.log(`  Confidence: ${prediction.confidence.toFixed(2)}`);
  console.log(`  Reasoning: ${prediction.reasoning.slice(0, 200)}`);
  console.log();

  if (prediction.effects.length > 0) {
    console.log(`  Direct effects:`);
    for (const effect of prediction.effects) {
      console.log(
        `    ${effect.variable}: ${effect.expectedValue} (${(effect.probability * 100).toFixed(0)}%) — ${effect.mechanism}`
      );
    }
  }

  if (prediction.sideEffects.length > 0) {
    console.log(`  Side effects:`);
    for (const se of prediction.sideEffects) {
      console.log(
        `    ${se.variable}: ${se.expectedValue} (${(se.probability * 100).toFixed(0)}%) ${se.unintended ? '[unintended]' : ''}`
      );
    }
  }

  section('3. Explaining an outcome');

  const explanation = await reasoner.explainCause('churn', 0.15, agentId, {
    observedVariables: {
      'ux-complexity': 0.8,
      'page-load-time': 3.2,
      'user-frustration': 0.7,
      'bounce-rate': 0.35,
    },
  });

  console.log(`  Effect: ${explanation.effect} = ${explanation.effectValue}`);
  console.log(`  Confidence: ${explanation.confidence.toFixed(2)}`);
  console.log(`  Summary: ${explanation.summary.slice(0, 200)}...`);
  console.log();

  if (explanation.rootCauses.length > 0) {
    console.log(`  Root causes:`);
    for (const rc of explanation.rootCauses) {
      console.log(
        `    ${rc.variable}: contribution=${rc.contribution.toFixed(2)} confidence=${rc.confidence.toFixed(2)}`
      );
      console.log(`      mechanism: ${rc.mechanism.slice(0, 100)}`);
      if (rc.suggestedIntervention) console.log(`      intervention: ${rc.suggestedIntervention}`);
    }
  }

  if (explanation.contributingFactors.length > 0) {
    console.log(`  Contributing factors:`);
    for (const cf of explanation.contributingFactors) {
      console.log(
        `    ${cf.variable}: ${cf.direction} (contribution: ${cf.contribution.toFixed(2)})`
      );
    }
  }

  if (explanation.counterfactuals.length > 0) {
    console.log(`  Counterfactuals:`);
    for (const cf of explanation.counterfactuals) {
      console.log(
        `    "${cf.change}" — would prevent: ${cf.wouldPrevent} (confidence: ${cf.confidence.toFixed(2)})`
      );
    }
  }

  section('4. Generating hypotheses');

  const hypotheses = await reasoner.generateHypotheses(agentId, 'reduce user churn');

  console.log(`  Generated ${hypotheses.length} hypotheses:`);
  for (const h of hypotheses.slice(0, 5)) {
    console.log(`  [${h.status}] ${h.cause} → ${h.effect}`);
    console.log(
      `    Relation: ${h.relationType} | Strength: ${h.strength.toFixed(2)} | Confidence: ${h.confidence.toFixed(2)}`
    );
    console.log(`    Source: ${h.source}`);
    if (h.evidence.length > 0) {
      console.log(`    Evidence: ${h.evidence.length} items`);
    }
  }

  section('5. Stats');

  const stats = reasoner.getStats();
  console.log(`  Graph nodes:            ${stats.graphNodes}`);
  console.log(`  Graph edges:            ${stats.graphEdges}`);
  console.log(`  Hypotheses pending:     ${stats.hypothesesPending}`);
  console.log(`  Hypotheses validated:   ${stats.hypothesesValidated}`);
  console.log(`  Hypotheses rejected:    ${stats.hypothesesRejected}`);
  console.log(`  Patterns stored:        ${stats.patternsStored}`);
  console.log(`  Interventions logged:   ${stats.interventionsLogged}`);
  console.log(`  Explanations generated: ${stats.explanationsGenerated}`);
  console.log(`  Plans generated:        ${stats.plansGenerated}`);

  console.log('\nDone.');
}

main();
