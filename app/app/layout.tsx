import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://techmap-live-undo-not.matsuoka-hiromu.chatgpt.site'),
  title: 'TechMap Live | 技術ディスカッションをリアルタイムに構造化',
  description: 'ZoomまたはMicrosoft Teams会議の発話を分析し、論点・決定・質問・アクションをライブマインドマップへ整理するワークスペース。',
  openGraph: {
    title: 'TechMap Live',
    description: '技術ディスカッションを、リアルタイムに構造化。',
    type: 'website',
    url: 'https://techmap-live-undo-not.matsuoka-hiromu.chatgpt.site',
    images: ['https://techmap-live-undo-not.matsuoka-hiromu.chatgpt.site/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TechMap Live',
    description: '技術ディスカッションを、リアルタイムに構造化。',
    images: ['https://techmap-live-undo-not.matsuoka-hiromu.chatgpt.site/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
