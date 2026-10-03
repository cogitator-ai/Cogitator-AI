import { ExplorerIsland } from '../islands';
import { featuresA } from './explorer/features-a';
import { featuresB } from './explorer/features-b';

/** "Everything in the box": every package with a live demo and a real snippet. */
export async function FeatureExplorerSection() {
  const [groupA, groupB] = await Promise.all([featuresA(), featuresB()]);
  return <ExplorerIsland features={[...groupA, ...groupB]} />;
}
