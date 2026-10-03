import { Explorer } from './explorer/Explorer';
import { featuresA } from './explorer/features-a';
import { featuresB } from './explorer/features-b';

/** "Everything in the box": every package with a live demo and a real snippet. */
export async function FeatureExplorerSection() {
  const [groupA, groupB] = await Promise.all([featuresA(), featuresB()]);
  return <Explorer features={[...groupA, ...groupB]} />;
}
