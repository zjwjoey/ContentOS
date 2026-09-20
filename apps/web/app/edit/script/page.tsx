import ScriptEditingV3Page from './v3/page';

// The product entry remains /edit/script. The V3 route is only a compatibility
// alias; the workbench and its business logic have a single implementation.
export default function ScriptEditPage() {
  return <ScriptEditingV3Page />;
}
