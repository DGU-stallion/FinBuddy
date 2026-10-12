'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Home() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, error } = useChat();

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">FinBuddy</h1>
          <p className="mt-1 text-sm text-slate-400">
            投资命题核验与理性算账助手 · 不提供投资建议
          </p>
        </header>

        <div className="flex-1 space-y-4">
          {messages.length === 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
              试试问：<span className="text-slate-200">中际旭创现在什么价？</span>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="space-y-2">
              {m.parts?.map((part, i) => {
                if (part.type === 'text' && part.text) {
                  return (
                    <div
                      key={i}
                      className={
                        m.role === 'user'
                          ? 'rounded-lg bg-sky-900/40 px-4 py-3 text-sm'
                          : 'rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm whitespace-pre-wrap'
                      }
                    >
                      {part.text}
                    </div>
                  );
                }
                if (part.type === 'tool-lookupStockSnapshot') {
                  const state = part.state;
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-3 font-mono text-xs"
                    >
                      <div className="mb-1 text-slate-400">
                        {state === 'output-available' ? '✓' : '⋯'} 调用工具 lookupStockSnapshot
                      </div>
                      {'input' in part && part.input != null && (
                        <div className="text-slate-300">
                          {JSON.stringify(part.input)}
                        </div>
                      )}
                      {state === 'output-available' && (
                        <div className="mt-2 text-slate-400">
                          返回：{JSON.stringify(part.output).slice(0, 400)}
                        </div>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          ))}

          {busy && <div className="text-xs text-slate-500">正在核验…</div>}
          {error && (
            <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              出错了：{error.message}
            </div>
          )}
        </div>

        <form
          className="mt-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy) return;
            sendMessage({ text: input });
            setInput('');
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入投资疑问，如：中际旭创现在什么价？"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm outline-none focus:border-sky-600"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-sky-600 px-5 py-3 text-sm font-medium disabled:opacity-50"
          >
            核验
          </button>
        </form>
      </div>
    </main>
  );
}
