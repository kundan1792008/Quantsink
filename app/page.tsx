import VIPTray from "@/components/VIPTray";
import InterestGraphFeed from "@/components/InterestGraphFeed";
import AddictionEngineDeck from "@/components/addiction/AddictionEngineDeck";
import ZeroLoadFeed from "@/components/ZeroLoadFeed";

export default function Home() {
  return (
    <main className="min-h-screen bg-brand-bg transition-opacity duration-500 delay-150">
      <VIPTray />
      <div className="pt-[72px]">
        <AddictionEngineDeck />
        <InterestGraphFeed />
        <ZeroLoadFeed />
      </div>
    </main>
  );
}
