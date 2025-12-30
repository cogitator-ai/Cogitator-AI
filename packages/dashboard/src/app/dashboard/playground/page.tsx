import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { PlaygroundChat } from '@/components/playground/PlaygroundChat';

export default function PlaygroundPage() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden bg-bg-primary bg-noise">
          <PlaygroundChat />
        </main>
      </div>
    </div>
  );
}
