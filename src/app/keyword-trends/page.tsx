'use client';

import { useState } from 'react';

export default function KeywordTrendsPage() {
  const [keyword, setKeyword] = useState('cozy bedroom decor');
  const [results, setResults] = useState<any[]>([
    { keyword: 'cozy bedroom decor', category: 'Home Decor', interest: 'High', saveSignal: 'High', competition: 'Strong', trend: 'Rising', opportunity: 'Best Bet' },
    { keyword: 'small apartment decor', category: 'Home Decor', interest: 'High', saveSignal: 'Strong', competition: 'Strong', trend: 'Rising', opportunity: 'Best Bet' },
    { keyword: 'neutral bedroom ideas', category: 'Home Decor', interest: 'Medium', saveSignal: 'Strong', competition: 'Strong', trend: 'Evergreen', opportunity: 'Steady' },
    { keyword: 'cozy room aesthetic', category: 'Room Aesthetic', interest: 'High', saveSignal: 'Strong', competition: 'Strong', trend: 'Rising', opportunity: 'Best Bet' },
    { keyword: 'minimalist bedroom decor', category: 'Home Decor', interest: 'Medium', saveSignal: 'Medium', competition: 'Medium', trend: 'Evergreen', opportunity: 'Steady' },
    { keyword: 'boho bedroom decor', category: 'Home Decor', interest: 'Medium', saveSignal: 'Medium', competition: 'Medium', trend: 'Seasonal', opportunity: 'Steady' },
    { keyword: 'bedroom wall decor ideas', category: 'Wall Decor', interest: 'Medium', saveSignal: 'Strong', competition: 'Strong', trend: 'Rising', opportunity: 'Best Bet' },
    { keyword: 'cozy bedding inspiration', category: 'Bedding', interest: 'High', saveSignal: 'Strong', competition: 'Strong', trend: 'Rising', opportunity: 'Best Bet' },
  ]);
  const [country, setCountry] = useState('USA');
  const [productType, setProductType] = useState('Physical Products');

  const handleSearch = async () => {
    // TODO: Connect to backend API
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-8 py-6">
        <h1 className="text-2xl font-bold mb-2">Keyword Tool</h1>
        <p className="text-gray-600">Research Pinterest keywords by demand, competition, and trend.</p>
      </div>

      {/* Search Bar */}
      <div className="bg-white border-b px-8 py-6">
        <div className="flex gap-4 mb-4">
          <select className="px-4 py-2 border rounded-lg bg-white">
            <option>🔴 Pinterest</option>
          </select>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="cozy bedroom decor"
            className="flex-1 px-4 py-2 border rounded-lg"
          />
          <select value={country} onChange={(e) => setCountry(e.target.value)} className="px-4 py-2 border rounded-lg bg-white">
            <option>🇺🇸 USA</option>
          </select>
          <button
            onClick={handleSearch}
            className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
          >
            Search Keywords
          </button>
        </div>

        {/* Recent Searches */}
        <div className="flex gap-2 text-sm">
          <span className="text-gray-500">Recent searches:</span>
          <button className="text-purple-600">cozy bedroom decor</button>
          <button className="text-gray-600">small apartment decor</button>
          <button className="text-gray-600">aesthetic nails</button>
          <button className="text-gray-600">digital planner</button>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-8 py-6">
        <h2 className="text-xl font-bold mb-4">{keyword}</h2>

        {/* Quick Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="p-4 bg-purple-50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">📈</span>
              <span className="text-purple-600 font-semibold">High</span>
            </div>
            <div className="text-sm text-gray-600">Pinterest Interest</div>
            <div className="text-xs text-gray-500 mt-1">Past 12 months</div>
          </div>
          <div className="p-4 bg-pink-50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">❤️</span>
              <span className="text-pink-600 font-semibold">Strong</span>
            </div>
            <div className="text-sm text-gray-600">Save Signal</div>
            <div className="text-xs text-gray-500 mt-1">Recent viral Pins</div>
          </div>
          <div className="p-4 bg-orange-50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">👥</span>
              <span className="text-orange-600 font-semibold">Medium</span>
            </div>
            <div className="text-sm text-gray-600">Competition</div>
            <div className="text-xs text-gray-500 mt-1">Visual crowding</div>
          </div>
          <div className="p-4 bg-green-50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">🏆</span>
              <span className="text-green-600 font-semibold">Best Bet</span>
            </div>
            <div className="text-sm text-gray-600">Opportunity</div>
            <div className="text-xs text-gray-500 mt-1">Worth testing this week</div>
          </div>
        </div>

        {/* Trend Chart */}
        <div className="bg-white rounded-lg p-6 mb-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="font-semibold mb-1">Search Trend · Past 12 months</h3>
              <p className="text-sm text-gray-600">Interest index based on Pinterest trend signals</p>
            </div>
            <div className="text-sm space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-green-600">↗</span>
                <span className="font-semibold">Rising steadily since February</span>
              </div>
              <div className="text-gray-600">Interest up 142% vs 6 months ago.</div>
              <div className="flex items-center gap-2 mt-2">
                <span>🏠</span>
                <span className="text-sm">Strong home decor overlap</span>
              </div>
              <div className="text-sm text-gray-600">High engagement with home + decor communities.</div>
              <div className="flex items-center gap-2 mt-2">
                <span>⭐</span>
                <span className="text-sm">Good fit for product-led Pins</span>
              </div>
              <div className="text-sm text-gray-600">Shoppers respond well to product roundups and styled room shots.</div>
            </div>
          </div>
          <div className="h-48 bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg flex items-end p-4">
            <svg className="w-full h-full" viewBox="0 0 800 150">
              <polyline
                points="0,120 50,115 100,110 150,105 200,100 250,95 300,90 350,85 400,75 450,65 500,60 550,50 600,40 650,30 700,25 750,20 800,15"
                fill="none"
                stroke="#9333EA"
                strokeWidth="2"
              />
            </svg>
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-4 mb-4">
          <button className={`px-4 py-2 rounded-lg ${productType === 'Physical Products' ? 'bg-purple-600 text-white' : 'bg-white border'}`} onClick={() => setProductType('Physical Products')}>
            🎁 Physical Products
          </button>
          <button className={`px-4 py-2 rounded-lg ${productType === 'Digital Products' ? 'bg-purple-600 text-white' : 'bg-white border'}`} onClick={() => setProductType('Digital Products')}>
            📄 Digital Products
          </button>
          <select className="px-4 py-2 border rounded-lg bg-white ml-auto">
            <option>Demand: All</option>
          </select>
          <select className="px-4 py-2 border rounded-lg bg-white">
            <option>Competition: All</option>
          </select>
          <select className="px-4 py-2 border rounded-lg bg-white">
            <option>Trend State: All</option>
          </select>
          <select className="px-4 py-2 border rounded-lg bg-white">
            <option>Category: All</option>
          </select>
          <button className="text-gray-600">🔄 Reset</button>
        </div>

        {/* Results Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">⭐ Keyword</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pinterest Interest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Save Signal</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Competition</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Trend</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Opportunity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {results.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">⭐</span>
                      <span className="text-sm font-medium">{row.keyword}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">{row.category}</span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <svg className="w-16 h-8" viewBox="0 0 60 30">
                        <polyline points="0,20 10,18 20,15 30,12 40,10 50,8 60,5" fill="none" stroke="#9333EA" strokeWidth="1.5"/>
                      </svg>
                      <span className={`text-sm font-semibold ${row.interest === 'High' ? 'text-purple-600' : 'text-orange-600'}`}>
                        {row.interest}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-semibold ${row.saveSignal === 'High' || row.saveSignal === 'Strong' ? 'text-pink-600' : 'text-orange-600'}`}>
                      {row.saveSignal}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-semibold ${row.competition === 'Strong' ? 'text-green-600' : 'text-orange-600'}`}>
                      {row.competition}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1">
                      <span className={`${row.trend === 'Rising' ? 'text-green-600' : row.trend === 'Evergreen' ? 'text-blue-600' : 'text-purple-600'}`}>
                        {row.trend === 'Rising' ? '↗' : row.trend === 'Evergreen' ? '—' : '◉'}
                      </span>
                      <span className={`text-sm ${row.trend === 'Rising' ? 'text-green-600' : row.trend === 'Evergreen' ? 'text-blue-600' : 'text-purple-600'}`}>
                        {row.trend}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-semibold ${row.opportunity === 'Best Bet' ? 'text-green-600' : 'text-blue-600'}`}>
                      {row.opportunity}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button className="text-purple-600 hover:text-purple-800 text-sm font-medium">Create Pins</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
