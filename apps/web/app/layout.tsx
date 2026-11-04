import type { Metadata, Viewport } from 'next';
import './smartappt-theme.css';
import './studio.css';

export const metadata: Metadata = {
  title: 'Design Studio · Integrata',
  description: 'AI-native residential design: describe a change, see the plan update.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#312e81',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
