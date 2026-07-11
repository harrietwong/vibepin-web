'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Sidebar() {
  const pathname = usePathname();
  
  const isActive = (path: string) => pathname === path;

  return (
    <div className="w-64 bg-white border-r min-h-screen p-6">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center text-white font-bold">V</div>
        <span className="text-xl font-bold">VibePin</span>
      </div>

      {/* Workflow Section */}
      <div className="mb-8">
        <div className="text-xs text-gray-500 uppercase mb-3">Workflow</div>
        <nav className="space-y-1">
          <Link href="/workspace" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/workspace') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>📊</span>
            <div>
              <div className="font-medium">Workspace</div>
              <div className="text-xs text-gray-500">Opportunity board</div>
            </div>
          </Link>
          <Link href="/weekly-plan" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/weekly-plan') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>📅</span>
            <div>
              <div className="font-medium">Weekly Plan</div>
              <div className="text-xs text-gray-500">This week's content</div>
            </div>
          </Link>
          <Link href="/create-pins" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/create-pins') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>✨</span>
            <div>
              <div className="font-medium">Create Pins</div>
              <div className="text-xs text-gray-500">AI generation</div>
            </div>
          </Link>
          <Link href="/generated-pins" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/generated-pins') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>🕐</span>
            <div>
              <div className="font-medium">Generated Pins</div>
              <div className="text-xs text-gray-500">Manage outputs</div>
            </div>
          </Link>
        </nav>
      </div>

      {/* Intelligence Section */}
      <div className="mb-8">
        <div className="text-xs text-gray-500 uppercase mb-3">Intelligence</div>
        <nav className="space-y-1">
          <Link href="/app/trends" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/app/trends') ? 'bg-purple-50 text-purple-600' : 'hover:bg-gray-50'}`}>
            <span>📊</span>
            <div>
              <div className="font-medium">Keyword Trends</div>
              <div className="text-xs text-gray-500">Demand & competition</div>
            </div>
          </Link>
          <Link href="/pin-opportunities" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/pin-opportunities') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>🔒</span>
            <div>
              <div className="font-medium">Pin Opportunities</div>
              <div className="text-xs text-gray-500">High-save visuals</div>
            </div>
          </Link>
          <Link href="/product-signals" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/product-signals') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>📦</span>
            <div>
              <div className="font-medium">Product Signals</div>
              <div className="text-xs text-gray-500">Products to create from</div>
            </div>
          </Link>
        </nav>
      </div>

      {/* System Section */}
      <div>
        <div className="text-xs text-gray-500 uppercase mb-3">System</div>
        <nav className="space-y-1">
          <Link href="/settings" className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isActive('/settings') ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
            <span>⚙️</span>
            <div>
              <div className="font-medium">Settings</div>
              <div className="text-xs text-gray-500">Account & preferences</div>
            </div>
          </Link>
        </nav>
      </div>
    </div>
  );
}
