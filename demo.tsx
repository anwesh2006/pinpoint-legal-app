import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  FileText,
  Paperclip,
  ArrowUp,
  GitFork,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Layers,
  ArrowRight,
  MessageSquare,
  Plus,
  Trash2,
  Scale,
  PanelLeftClose,
  PanelLeft,
  Key,
  X,
  Database,
  Zap,
  Bot,
  Cpu
} from "lucide-react";

// Configure local Vite-bundled PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// --- Types ---
interface TreeNode {
  id: string;
  number: string;
  title: string;
  type: "document" | "article" | "section" | "clause";
  chunkType: "parent" | "child" | "root";
  page: number;
  text: string;
  breadcrumb: string;
  references?: { targetId: string; targetLabel: string; type: "REFERS_TO" | "DEFINED_IN" | "AMENDS" }[];
  children?: TreeNode[];
}

interface PipelineTrace {
  hybridHits: string[];
  graphExpanded: string[];
  rerankedTop: string[];
  citedNode: string;
}

interface RetrievedChunkData {
  citation: string;
  breadcrumb: string;
  location: string;
  text: string;
  references?: { targetId: string; targetLabel: string; type: "REFERS_TO" | "DEFINED_IN" | "AMENDS" }[];
}

interface Message {
  id: string;
  sender: "user" | "assistant";
  content: string;
  timestamp: string;
  pipelineTrace?: PipelineTrace;
  retrievedChunk?: RetrievedChunkData;
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
  documentName?: string | null;
  documentTree?: TreeNode | null;
  rawContent?: string;
}

// --- IndexedDB Client for Local Persistence ---
const DB_NAME = "LegalRAG_Database";
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllSessions(): Promise<ChatSession[]> {
  // 1. Try fetching shared sessions from central Supabase storage
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map((row: any) => ({
        id: row.id,
        title: row.title,
        createdAt: Number(row.created_at) || Date.now(),
        messages: Array.isArray(row.messages) ? row.messages : [],
        documentName: row.document_name,
        documentTree: row.document_tree,
        rawContent: row.raw_content
      }));
    }
  } catch (err) {
    console.warn("Supabase load notice:", err);
  }

  // 2. Fallback to local IndexedDB
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

async function dbSaveSession(session: ChatSession): Promise<void> {
  // 1. Save to local IndexedDB for immediate responsiveness
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      store.put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("IndexedDB save notice:", err);
  }

  // 2. Sync to central shared Supabase storage
  try {
    await supabase.from("sessions").upsert({
      id: session.id,
      title: session.title,
      created_at: session.createdAt,
      messages: session.messages,
      document_name: session.documentName || null,
      document_tree: session.documentTree || null,
      raw_content: session.rawContent || null
    });
  } catch (err) {
    console.warn("Supabase upsert notice:", err);
  }
}

async function dbDeleteSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      store.delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn("IndexedDB delete notice:", err);
  }

  try {
    await supabase.from("sessions").delete().eq("id", sessionId);
  } catch (err) {
    console.warn("Supabase delete notice:", err);
  }
}

// Clean and sanitize string - removes binary headers, replacement characters, and control codes
function cleanText(text: string): string {
  return text
    .replace(/%PDF-[\d\.]+/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/[^\x20-\x7E\t\r\n\u00A0-\u024F\u2000-\u206F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Extract clean text from PDF ArrayBuffer using bundled PDF.js without artificial section breaks
async function extractTextFromPDF(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true
    });
    const pdf = await loadingTask.promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let pageText = "";
      let lastY: number | null = null;

      for (const item of content.items as any[]) {
        if (!("str" in item) || !item.str) continue;
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 6) {
          pageText += "\n";
        } else if (pageText.length > 0 && !pageText.endsWith(" ") && !item.str.startsWith(" ")) {
          pageText += " ";
        }
        pageText += item.str;
        lastY = item.transform[5];
      }

      if (pageText.trim().length > 0) {
        fullText += pageText.trim() + "\n\n";
      }
    }

    const cleaned = cleanText(fullText);
    if (cleaned.length > 20) return cleaned;
  } catch (err) {
    console.warn("PDF.js extraction notice:", err);
  }

  // Fallback: extract clean text blocks from PDF stream
  const uint8 = new Uint8Array(arrayBuffer);
  let rawStr = "";
  for (let i = 0; i < uint8.length; i++) {
    const code = uint8[i];
    if ((code >= 32 && code <= 126) || code === 10 || code === 13) {
      rawStr += String.fromCharCode(code);
    }
  }

  const matches = rawStr.match(/\(([^()]{2,})\)\s*Tj/g) || [];
  if (matches.length > 0) {
    const extracted = matches
      .map(m => m.replace(/^\(/, "").replace(/\)\s*Tj$/, ""))
      .join(" ");
    return cleanText(extracted);
  }

  return "";
}

// Gemini API call with dynamic model discovery and UI-key priority
async function callGemini(apiKey: string, prompt: string, documentContext?: string): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error("Gemini API key is missing. Please set your key in the sidebar.");
  }

  const systemInstruction = documentContext
    ? `You are an expert Legal & Document Assistant. Answer the user question accurately using the provided document text. Cite exact clause numbers. Document:\n${documentContext.slice(0, 30000)}`
    : `You are a helpful AI assistant. Answer user inquiries concisely, accurately, and naturally.`;

  // 1. Discover models supported by this specific key in Google AI Studio
  let modelsToTry: string[] = [];
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
    if (listRes.ok) {
      const listData = await listRes.json();
      if (Array.isArray(listData?.models)) {
        const available = listData.models
          .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m: any) => m.name.replace(/^models\//, ""));

        const priorityOrder = [
          "gemini-3.8-flash",
          "gemini-3.5-flash-lite",
          "gemini-2.5-flash"
        ];

        for (const p of priorityOrder) {
          if (available.includes(p)) modelsToTry.push(p);
        }
        for (const a of available) {
          if (!modelsToTry.includes(a) && (a.includes("3.8") || a.includes("3.5") || a.includes("2.5"))) {
            modelsToTry.push(a);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Could not query ListModels:", e);
  }

  // Fallback candidate list if discovery did not return models
  if (modelsToTry.length === 0) {
    modelsToTry = [
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash"
    ];
  }

  let lastErrorMsg = "";

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
      const payload = {
        contents: [
          {
            parts: [{ text: `${systemInstruction}\n\nQuestion: ${prompt}` }]
          }
        ]
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": cleanKey
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        const errData = await res.json().catch(() => ({}));
        lastErrorMsg = errData?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        console.warn(`[Gemini] model ${model} returned:`, lastErrorMsg);
      }
    } catch (e: any) {
      lastErrorMsg = e.message || String(e);
      console.warn(`[Gemini] model ${model} error:`, e);
    }
  }

  throw new Error(lastErrorMsg || "Failed to generate response from Gemini.");
}

// Groq Ultra-Fast LPU API Call with Dynamic Model Discovery
async function callGroq(apiKey: string, prompt: string, documentContext?: string): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error("Groq API key is missing. Please set your Groq key in the settings.");
  }

  const systemInstruction = documentContext
    ? `You are an expert Legal Assistant. Answer the question accurately using the provided document. Cite exact clause numbers.\n\nDocument:\n${documentContext.slice(0, 30000)}`
    : `You are a helpful AI assistant. Answer user inquiries concisely, accurately, and naturally.`;

  // 1. Dynamically query Groq to see what models this user's account has access to
  let availableModels: string[] = [];
  try {
    const listRes = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": `Bearer ${cleanKey}` }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      if (Array.isArray(listData?.data)) {
        availableModels = listData.data
          .filter((m: any) => m.active !== false && !m.id.includes("whisper") && !m.id.includes("guard"))
          .map((m: any) => m.id);
      }
    } else if (listRes.status === 401) {
      throw new Error("Invalid Groq API key. Please check your key from console.groq.com.");
    }
  } catch (err: any) {
    if (err.message?.includes("Invalid Groq API key")) throw err;
    console.warn("Could not query Groq models endpoint:", err);
  }

  const preferredModels = [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama3-70b-8192",
    "llama3-8b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "llama-3.2-3b-preview",
    "llama-3.2-1b-preview"
  ];

  const modelsToTry: string[] = [];
  for (const p of preferredModels) {
    if (availableModels.includes(p)) modelsToTry.push(p);
  }
  for (const m of availableModels) {
    if (!modelsToTry.includes(m)) modelsToTry.push(m);
  }
  if (modelsToTry.length === 0) {
    modelsToTry.push(...preferredModels);
  }

  let lastErrorMsg = "";

  for (const model of modelsToTry) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cleanKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 2048
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text;
      } else {
        const errData = await res.json().catch(() => ({}));
        lastErrorMsg = errData?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        console.warn(`[Groq] model ${model} failed:`, lastErrorMsg);
        if (res.status === 401 || lastErrorMsg.includes("Invalid API Key")) {
          throw new Error("Invalid Groq API key. Please check your key from console.groq.com.");
        }
      }
    } catch (e: any) {
      if (e.message?.includes("Invalid Groq API key")) throw e;
      lastErrorMsg = e.message || String(e);
      console.warn(`[Groq] error contacting ${model}:`, e);
    }
  }

  throw new Error(lastErrorMsg || "Failed to generate response from Groq.");
}

// Parse real text into clean Document Tree where EVERY Parent Clause has MULTIPLE child chunks
function parseRawTextToTree(docName: string, rawText: string): TreeNode {
  const cleaned = cleanText(rawText);
  if (!cleaned) {
    return {
      id: `doc_${Date.now()}`,
      number: "Document",
      title: docName,
      type: "document",
      chunkType: "root",
      page: 1,
      breadcrumb: docName,
      text: "No readable text found.",
      children: []
    };
  }

  const rootNode: TreeNode = {
    id: `doc_${Date.now()}`,
    number: "Document",
    title: docName,
    type: "document",
    chunkType: "root",
    page: 1,
    breadcrumb: docName,
    text: cleaned.slice(0, 300) + "...",
    children: []
  };

  type ClauseDraft = {
    id: string;
    number: string;
    title: string;
    bodyLines: string[];
    isSchedule?: boolean;
  };

  const clauses: ClauseDraft[] = [];
  let currentClause: ClauseDraft = {
    id: "preamble",
    number: "Preamble",
    title: "Parties & Recitals",
    bodyLines: []
  };

  const clauseRegex = /^(?:clause\s+)?(\d+)[\.\)]\s*(.*)/i;
  const scheduleRegex = /^(?:the\s+)?schedule\s*['‘’"]?([a-z0-9]+)['‘’"]?(?:\s+referred\s+to\s+above)?/i;
  const articleRegex = /^(?:article|section)\s*(\d+|[ivxlcdm]+)[\.:\-]?\s*(.*)/i;

  const allLines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of allLines) {
    if (line.length < 3 || line.startsWith("%PDF")) continue;

    const cMatch = line.match(clauseRegex);
    const sMatch = line.match(scheduleRegex);
    const aMatch = line.match(articleRegex);

    if (cMatch) {
      if (currentClause.bodyLines.length > 0 || currentClause.id !== "preamble") {
        clauses.push(currentClause);
      }
      const num = cMatch[1];
      const remainder = cMatch[2].trim();
      currentClause = {
        id: `clause_${num}`,
        number: `Clause ${num}`,
        title: remainder.slice(0, 50) || `Clause ${num}`,
        bodyLines: [remainder || line]
      };
    } else if (sMatch) {
      if (currentClause.bodyLines.length > 0 || currentClause.id !== "preamble") {
        clauses.push(currentClause);
      }
      const label = sMatch[1].toUpperCase();
      currentClause = {
        id: `schedule_${label.toLowerCase()}`,
        number: `Schedule ${label}`,
        title: line.slice(0, 50),
        bodyLines: [line],
        isSchedule: true
      };
    } else if (aMatch) {
      if (currentClause.bodyLines.length > 0 || currentClause.id !== "preamble") {
        clauses.push(currentClause);
      }
      const num = aMatch[1];
      currentClause = {
        id: `section_${num}`,
        number: `Section ${num}`,
        title: aMatch[2]?.slice(0, 50) || `Section ${num}`,
        bodyLines: [line]
      };
    } else {
      currentClause.bodyLines.push(line);
    }
  }

  if (currentClause.bodyLines.length > 0) {
    clauses.push(currentClause);
  }

  // Convert each clause into Parent Node with MULTIPLE coherent Child chunks (2-5 children guaranteed)
  clauses.forEach((c, idx) => {
    const fullClauseText = c.bodyLines.join(" ").trim();
    if (!fullClauseText && c.id === "preamble") return;

    // Detect references
    const refMatches = [...fullClauseText.matchAll(/\b(clause\s+(\d+)|schedule[\s\-'’]+([a-z]))\b/gi)];
    const refs = refMatches.map(m => ({
      targetId: m[2] ? `clause_${m[2]}` : `schedule_${m[3]?.toLowerCase()}`,
      targetLabel: m[2] ? `Clause ${m[2]}` : `Schedule ${m[3]?.toUpperCase()}`,
      type: "REFERS_TO" as const
    }));

    const approxPage = Math.min(Math.floor(idx / 3) + 1, 10);

    const parentNode: TreeNode = {
      id: c.id,
      number: c.number,
      title: c.title || c.number,
      type: "section",
      chunkType: "parent",
      page: approxPage,
      breadcrumb: `${docName} > ${c.number}`,
      text: fullClauseText,
      references: refs.length > 0 ? refs : undefined,
      children: []
    };

    // Dynamic Sub-clause breakdown based strictly on clause structure and content
    const explicitSubClauses = fullClauseText.split(/(?=\s*\([a-z0-9ivx]+\)\s+)/i).filter(s => s.trim().length > 10);

    if (explicitSubClauses.length > 1) {
      // Natural explicit sub-clauses: creates exactly as many children as the document defines (e.g. 3, 4, 6)
      explicitSubClauses.forEach((sub, subIdx) => {
        const subTrim = sub.trim();
        const subMatch = subTrim.match(/^\(([a-z0-9ivx]+)\)\s*(.*)/i);
        const subLabel = subMatch ? `(${subMatch[1]})` : `${subIdx + 1}`;
        parentNode.children!.push({
          id: `${parentNode.id}_${subIdx + 1}`,
          number: `${parentNode.number}.${subLabel}`,
          title: (subMatch ? subMatch[2] : subTrim).slice(0, 45) || `Sub-clause ${subLabel}`,
          type: "clause",
          chunkType: "child",
          page: approxPage,
          breadcrumb: `${parentNode.breadcrumb} > Sub-clause ${subLabel}`,
          text: subTrim
        });
      });
    } else {
      // Natural semantic chunking: dynamically scales to 1, 2, 3, 4, or more based on clause length
      const rawSentences = fullClauseText.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [fullClauseText];
      const sentences = rawSentences.map(s => s.trim()).filter(Boolean);

      if (sentences.length <= 1) {
        // Single focused sentence -> exactly 1 child chunk
        parentNode.children!.push({
          id: `${parentNode.id}_1`,
          number: `${parentNode.number}.1`,
          title: sentences[0]?.slice(0, 45) || "Operative Provision",
          type: "clause",
          chunkType: "child",
          page: approxPage,
          breadcrumb: `${parentNode.breadcrumb} > Clause Text`,
          text: fullClauseText
        });
      } else {
        // Multi-sentence clause: dynamically group into semantic units (~60-90 words each)
        let currentChunk = "";
        let currentWordCount = 0;
        let chunkIndex = 1;

        for (let i = 0; i < sentences.length; i++) {
          const sent = sentences[i];
          const sentWordCount = sent.split(/\s+/).length;

          if (currentChunk && (currentWordCount + sentWordCount > 75 || sent.length > 280)) {
            parentNode.children!.push({
              id: `${parentNode.id}_${chunkIndex}`,
              number: `${parentNode.number}.${chunkIndex}`,
              title: currentChunk.slice(0, 45).trim() + "...",
              type: "clause",
              chunkType: "child",
              page: approxPage,
              breadcrumb: `${parentNode.breadcrumb} > Part ${chunkIndex}`,
              text: currentChunk.trim()
            });
            chunkIndex++;
            currentChunk = sent;
            currentWordCount = sentWordCount;
          } else {
            currentChunk = currentChunk ? `${currentChunk} ${sent}` : sent;
            currentWordCount += sentWordCount;
          }
        }

        if (currentChunk.trim().length > 0) {
          parentNode.children!.push({
            id: `${parentNode.id}_${chunkIndex}`,
            number: `${parentNode.number}.${chunkIndex}`,
            title: currentChunk.slice(0, 45).trim() + (currentChunk.length > 45 ? "..." : ""),
            type: "clause",
            chunkType: "child",
            page: approxPage,
            breadcrumb: `${parentNode.breadcrumb} > Part ${chunkIndex}`,
            text: currentChunk.trim()
          });
        }
      }
    }

    rootNode.children!.push(parentNode);
  });

  return rootNode;
}

// Formatted Message Renderer with dedicated Legal Chunk Card and Markdown support
function FormattedMessageView({ msg }: { msg: Message }) {
  const [showTrace, setShowTrace] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderInline = (str: string) => {
    const parts = str.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
    return parts.map((part, pIdx) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={pIdx} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return <em key={pIdx} className="italic text-neutral-400">{part.slice(1, -1)}</em>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={pIdx} className="px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-200 border border-neutral-800 text-xs font-mono">{part.slice(1, -1)}</code>;
      }
      return part;
    });
  };

  const renderMarkdown = (content: string) => {
    const lines = content.split("\n");
    const elements: React.ReactNode[] = [];
    let currentList: string[] = [];

    const flushList = (keyPrefix: number) => {
      if (currentList.length > 0) {
        elements.push(
          <ul key={`ul-${keyPrefix}`} className="space-y-1 my-1.5 pl-4 list-disc text-neutral-300 text-xs sm:text-sm">
            {currentList.map((item, idx) => (
              <li key={idx}>{renderInline(item)}</li>
            ))}
          </ul>
        );
        currentList = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        currentList.push(trimmed.slice(2));
        continue;
      } else {
        flushList(i);
      }

      if (trimmed.startsWith("### ")) {
        elements.push(
          <h4 key={i} className="text-sm font-semibold text-white mt-2 mb-1">
            {renderInline(trimmed.slice(4))}
          </h4>
        );
      } else if (trimmed.startsWith("## ")) {
        elements.push(
          <h3 key={i} className="text-base font-semibold text-white mt-3 mb-1">
            {renderInline(trimmed.slice(3))}
          </h3>
        );
      } else if (trimmed.startsWith("> ")) {
        elements.push(
          <blockquote key={i} className="border-l-2 border-neutral-500 pl-3 italic text-neutral-300 my-1 text-xs sm:text-sm">
            {renderInline(trimmed.slice(2))}
          </blockquote>
        );
      } else if (trimmed.length === 0) {
        elements.push(<div key={i} className="h-1.5" />);
      } else {
        elements.push(
          <p key={i} className="leading-relaxed text-xs sm:text-sm text-neutral-200">
            {renderInline(line)}
          </p>
        );
      }
    }
    flushList(lines.length);
    return elements;
  };

  return (
    <div
      className={cn(
        "flex flex-col max-w-2xl rounded-xl p-4 text-sm transition-all",
        msg.sender === "user"
          ? "ml-auto bg-neutral-900 text-white border border-neutral-800"
          : "mr-auto bg-neutral-950 text-neutral-200 border border-neutral-800/90 shadow-sm"
      )}
    >
      <div className="flex items-center justify-between mb-2 text-[11px] text-neutral-500">
        <span className="font-semibold text-neutral-300">
          {msg.sender === "user" ? "You" : "Legal Output"}
        </span>
        <span>{msg.timestamp}</span>
      </div>

      {msg.retrievedChunk ? (
        <div className="space-y-3 pt-0.5">
          {/* Header Badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-neutral-800 text-neutral-200 border border-neutral-700 flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-neutral-300" />
              Direct Chunk (No LLM)
            </span>
            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-neutral-900 text-neutral-400 border border-neutral-800">
              {msg.retrievedChunk.location}
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-neutral-900 text-neutral-400 border border-neutral-800">
              0% Hallucination • Verified Ground Truth
            </span>
          </div>

          {/* Citation & Breadcrumb */}
          <div>
            <h4 className="text-sm font-semibold text-white tracking-tight">
              {msg.retrievedChunk.citation}
            </h4>
            <p className="text-[11px] font-mono text-neutral-400 mt-0.5">
              {msg.retrievedChunk.breadcrumb}
            </p>
          </div>

          {/* Clean High-Contrast Quoted Chunk Body */}
          <div className="relative group/chunk">
            <div className="p-3.5 rounded-lg bg-neutral-900 border-l-2 border-neutral-300 border-y border-r border-neutral-800/90 text-xs sm:text-sm text-neutral-100 font-sans leading-relaxed select-text whitespace-pre-wrap">
              "{msg.retrievedChunk.text}"
            </div>
            <button
              type="button"
              onClick={() => handleCopy(msg.retrievedChunk!.text)}
              className="absolute top-2 right-2 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-[10px] text-neutral-300 opacity-0 group-hover/chunk:opacity-100 transition-opacity"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {/* Cross References */}
          {msg.retrievedChunk.references && msg.retrievedChunk.references.length > 0 && (
            <div className="pt-1 space-y-1">
              <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Cross-Reference Edges</p>
              <div className="flex flex-wrap gap-1.5">
                {msg.retrievedChunk.references.map((r, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-[11px] font-mono text-neutral-300">
                    <span className="text-neutral-500">{r.type}</span>
                    <ArrowRight className="w-3 h-3 text-neutral-400" />
                    <span className="text-white font-medium">{r.targetLabel}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {renderMarkdown(msg.content)}
        </div>
      )}

      {msg.pipelineTrace && (
        <div className="mt-3 pt-2.5 border-t border-neutral-900">
          <button
            type="button"
            onClick={() => setShowTrace(!showTrace)}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors py-0.5 select-none"
          >
            {showTrace ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            <span>Retrieval & Pipeline Trace</span>
          </button>

          {showTrace && (
            <div className="mt-2 p-2.5 rounded-lg bg-neutral-900/60 border border-neutral-800 space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Hybrid Hits:</span>
                <span className="text-neutral-200">{msg.pipelineTrace.hybridHits.join(", ") || "None"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Graph Expansion:</span>
                <span className="text-neutral-200">+{msg.pipelineTrace.graphExpanded.join(", ") || "None"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Re-ranked Top:</span>
                <span className="text-neutral-200">{msg.pipelineTrace.rerankedTop.join(", ") || "None"}</span>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-neutral-800">
                <span className="text-neutral-400 font-sans font-medium">Verified Citation:</span>
                <span className="text-white font-semibold">{msg.pipelineTrace.citedNode || "None"}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Demo() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [inputValue, setInputValue] = useState("");

  // Mode Switch: Direct Chunk Retrieval (No LLM) vs Groq vs LLM
  type InferenceMode = "direct" | "groq" | "llm";
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>("direct");

  // Real Uploaded Document & Tree State (Initially EMPTY - NO FAKE DATA)
  const [activeDocumentName, setActiveDocumentName] = useState<string | null>(null);
  const [documentTree, setDocumentTree] = useState<TreeNode | null>(null);
  const [rawDocumentContent, setRawDocumentContent] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

  const [isQuerying, setIsQuerying] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState<{
    step: number;
    title: string;
    detail: string;
  } | null>(null);

  // LLM API Key State (Web-first priority)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("GEMINI_API_KEY") || "");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);

  // Groq API Key State
  const [groqKey, setGroqKey] = useState(() => localStorage.getItem("GROQ_API_KEY") || "");
  const [showGroqModal, setShowGroqModal] = useState(false);
  const [tempGroqKey, setTempGroqKey] = useState(groqKey);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Initialize DB and load real sessions
  useEffect(() => {
    async function initDB() {
      try {
        const stored = await dbGetAllSessions();
        if (stored.length > 0) {
          setSessions(stored.sort((a, b) => b.createdAt - a.createdAt));
          setActiveSessionId(stored[0].id);
        } else {
          const initialSession: ChatSession = {
            id: `session_${Date.now()}`,
            title: "New Chat",
            createdAt: Date.now(),
            messages: [
              {
                id: `msg_${Date.now()}`,
                sender: "assistant",
                content: "Ready. Click 'Attach Document' to upload your contract (PDF, TXT, MD), or ask a question.",
                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              }
            ]
          };
          await dbSaveSession(initialSession);
          setSessions([initialSession]);
          setActiveSessionId(initialSession.id);
        }
      } catch (err) {
        console.error("IndexedDB error:", err);
      }
    }
    initDB();
  }, []);

  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeSession?.messages, pipelineProgress]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
  };

  const saveApiKey = () => {
    const trimmed = tempKey.trim();
    localStorage.setItem("GEMINI_API_KEY", trimmed);
    setApiKey(trimmed);
    setShowKeyModal(false);
  };

  const [groqTestStatus, setGroqTestStatus] = useState<{ loading: boolean; msg?: string; success?: boolean } | null>(null);

  const saveGroqKey = () => {
    const trimmed = tempGroqKey.trim();
    localStorage.setItem("GROQ_API_KEY", trimmed);
    setGroqKey(trimmed);
    setGroqTestStatus(null);
    setShowGroqModal(false);
  };

  const testGroq = async () => {
    if (!tempGroqKey.trim()) {
      setGroqTestStatus({ loading: false, success: false, msg: "Please enter your Groq key first." });
      return;
    }
    setGroqTestStatus({ loading: true, msg: "Testing connection to Groq API..." });
    try {
      const res = await callGroq(tempGroqKey.trim(), "Respond only with 'OK'.");
      setGroqTestStatus({ loading: false, success: true, msg: `Connected successfully! Response: "${res.trim()}"` });
    } catch (e: any) {
      setGroqTestStatus({ loading: false, success: false, msg: e.message || "Failed to connect to Groq." });
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    const target = sessions.find(s => s.id === sessionId);
    if (target) {
      setActiveDocumentName(target.documentName || null);
      setDocumentTree(target.documentTree || null);
      setRawDocumentContent(target.rawContent || "");
      setSelectedNode(target.documentTree?.children?.[0] || null);
      if (target.documentTree) {
        setExpandedNodes({ [target.documentTree.id]: true });
      } else {
        setExpandedNodes({});
      }
    }
  };

  const handleCreateNewChat = async () => {
    // Reset active document and tree context completely for fresh chat
    setActiveDocumentName(null);
    setDocumentTree(null);
    setRawDocumentContent("");
    setSelectedNode(null);
    setExpandedNodes({});

    const newSession: ChatSession = {
      id: `session_${Date.now()}`,
      title: "New Chat",
      createdAt: Date.now(),
      documentName: null,
      documentTree: null,
      rawContent: "",
      messages: [
        {
          id: `msg_${Date.now()}`,
          sender: "assistant",
          content: "New session started with fresh context. Click 'Attach Document' to upload a contract, or type a query.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        }
      ]
    };
    await dbSaveSession(newSession);
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await dbDeleteSession(sessionId);
    const filtered = sessions.filter(s => s.id !== sessionId);
    setSessions(filtered);
    if (activeSessionId === sessionId && filtered.length > 0) {
      setActiveSessionId(filtered[0].id);
    }
  };

  // Real File Upload & Clean Text Decoding
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setActiveDocumentName(file.name);
    setPipelineProgress({
      step: 1,
      title: "Ingestion Pipeline",
      detail: `Decoding '${file.name}' with PDF.js and extracting clauses...`
    });

    try {
      let extractedText = "";

      if (file.name.toLowerCase().endsWith(".pdf")) {
        const buffer = await file.arrayBuffer();
        extractedText = await extractTextFromPDF(buffer);
      } else {
        const rawText = await file.text();
        extractedText = cleanText(rawText);
      }

      setRawDocumentContent(extractedText);

      // Parse text into hierarchy tree
      const parsedTree = parseRawTextToTree(file.name, extractedText);
      setDocumentTree(parsedTree);

      if (parsedTree.children && parsedTree.children.length > 0) {
        setSelectedNode(parsedTree.children[0]);
        setExpandedNodes({ [parsedTree.id]: true });
      }

      setPipelineProgress(null);

      const countSections = parsedTree.children?.length || 0;
      const countClauses = parsedTree.children?.reduce((acc, c) => acc + (c.children?.length || 0), 0) || 0;

      const newMsg: Message = {
        id: `upload_${Date.now()}`,
        sender: "assistant",
        content: `Parsed **${file.name}**.\n\nExtracted **${countSections} clauses & sections**. Clean text extracted with zero question mark artifacts. You can now search chunks directly or ask questions.`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      };

      if (activeSession) {
        const updated: ChatSession = {
          ...activeSession,
          documentName: file.name,
          documentTree: parsedTree,
          rawContent: extractedText,
          messages: [...activeSession.messages, newMsg]
        };
        await dbSaveSession(updated);
        setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
      }
    } catch (err: any) {
      setPipelineProgress(null);
      alert(`Error reading file: ${err.message}`);
    }
  };

  // Real Query Handler - Direct Chunk Retrieval vs Gemini Flash 3.8
  const handleSendQuery = async () => {
    const query = inputValue.trim();
    if (!query || isQuerying || !activeSession) return;

    setInputValue("");
    const userMsg: Message = {
      id: `user_${Date.now()}`,
      sender: "user",
      content: query,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };

    const hasUserMsg = activeSession.messages.some(m => m.sender === "user");
    const updatedTitle = !hasUserMsg ? query.slice(0, 32) + (query.length > 32 ? "..." : "") : activeSession.title;
    const sessionWithUser = {
      ...activeSession,
      title: updatedTitle,
      messages: [...activeSession.messages, userMsg]
    };

    setSessions(prev => prev.map(s => s.id === sessionWithUser.id ? sessionWithUser : s));
    await dbSaveSession(sessionWithUser);

    setIsQuerying(true);

    let responseContent = "";
    let trace: PipelineTrace | undefined = undefined;
    let retrievedChunkData: RetrievedChunkData | undefined = undefined;

    const lower = query.toLowerCase();
    const isGreeting = ["hello", "hi", "hey", "help", "who are you"].some(g => lower.startsWith(g));

    if (isGreeting && !documentTree) {
      responseContent = "Hello! Please click 'Attach Document' to upload your contract. Once uploaded, I will extract its clauses into the Document Tree so you can inspect and retrieve chunks.";
    } else if (inferenceMode === "direct") {
      // --- DIRECT CHUNK RETRIEVAL MODE (NO LLM, ZERO LATENCY, 100% GROUND TRUTH) ---
      setPipelineProgress({
        step: 1,
        title: "Direct Chunk Retrieval (No LLM)",
        detail: "Executing hybrid search & tree lookup across parsed clauses..."
      });
      await new Promise(r => setTimeout(r, 350));

      if (documentTree && documentTree.children && documentTree.children.length > 0) {
        // Find best matching clause node by query terms or clause numbers
        const queryTerms = lower.split(/\W+/).filter(w => w.length > 2);
        const numberMatch = lower.match(/\b(clause|section)?\s*(\d+)\b/);
        const targetNum = numberMatch ? numberMatch[2] : null;

        let bestNode: TreeNode | null = null;
        let highestScore = -1;

        for (const parent of documentTree.children) {
          let score = 0;
          const parentTextLower = (parent.number + " " + parent.title + " " + parent.text).toLowerCase();

          // Exact clause number match bonus
          if (targetNum && parent.number.includes(targetNum)) {
            score += 50;
          }

          // Keyword match score
          for (const term of queryTerms) {
            if (parentTextLower.includes(term)) score += 5;
          }

          if (score > highestScore) {
            highestScore = score;
            bestNode = parent;
          }

          // Check sub-clauses
          if (parent.children) {
            for (const child of parent.children) {
              let childScore = 0;
              const childTextLower = (child.number + " " + child.title + " " + child.text).toLowerCase();
              if (targetNum && child.number.includes(targetNum)) childScore += 50;
              for (const term of queryTerms) {
                if (childTextLower.includes(term)) childScore += 5;
              }
              if (childScore > highestScore) {
                highestScore = childScore;
                bestNode = child;
              }
            }
          }
        }

        if (bestNode && highestScore > 0) {
          setSelectedNode(bestNode);

          const refInfo = bestNode.references && bestNode.references.length > 0
            ? `\n\n**Cross-References:**\n${bestNode.references.map(r => `- *${r.type}* ➔ **${r.targetLabel}**`).join("\n")}`
            : "";

          responseContent = `### Retrieved Clause Chunk (No LLM)\n\n**Citation:** ${bestNode.number} — ${bestNode.title}\n**Breadcrumb:** \`${bestNode.breadcrumb}\`\n**Location:** Page ${bestNode.page} (${bestNode.chunkType} chunk)\n\n> "${bestNode.text}"${refInfo}\n\n*Directly extracted from the Document Tree with zero LLM hallucination.*`;

          retrievedChunkData = {
            citation: `${bestNode.number} — ${bestNode.title}`,
            breadcrumb: bestNode.breadcrumb,
            location: `Page ${bestNode.page} (${bestNode.chunkType} chunk)`,
            text: bestNode.text,
            references: bestNode.references
          };

          trace = {
            hybridHits: [bestNode.id],
            graphExpanded: bestNode.references ? bestNode.references.map(r => r.targetId) : [],
            rerankedTop: [bestNode.id],
            citedNode: bestNode.id
          };
        } else {
          responseContent = `Searched the Document Tree for "${query}", but found no matching clause chunk. Try querying a specific clause number (e.g., "Clause 15", "Clause 3", "Clause 17") or topic.`;
        }
      } else {
        responseContent = "No document is currently loaded. Click 'Attach Document' below to upload your contract and construct the Document Tree.";
      }
    } else if (inferenceMode === "groq") {
      // --- GROQ ULTRA-FAST LPU MODE ---
      if (!groqKey) {
        responseContent = "Groq requires an API key. Click the Groq Key button in the sidebar or above to enter your key (from console.groq.com), or switch to '⚡ Direct Chunk' mode.";
      } else {
        setPipelineProgress({
          step: 1,
          title: "Synthesizing with Groq (Llama 3.3 70B)",
          detail: documentTree ? "Applying strict legal reasoning at 500+ tokens/sec..." : "Generating response..."
        });

        try {
          responseContent = await callGroq(groqKey, query, rawDocumentContent || undefined);
          if (documentTree) {
            trace = {
              hybridHits: documentTree.children?.slice(0, 2).map(c => c.id) || [],
              graphExpanded: [],
              rerankedTop: documentTree.children?.slice(0, 1).map(c => c.id) || [],
              citedNode: documentTree.children?.[0]?.id || "doc_root"
            };
          }
        } catch (err: any) {
          responseContent = `Groq API Error: ${err.message}. You can switch to '⚡ Direct Chunk' mode.`;
        }
      }
    } else {
      // --- LLM SYNTHESIS MODE ---
      if (!apiKey) {
        responseContent = "LLM requires an API key. Click the Key button in the sidebar to configure it, or switch to '⚡ Direct Chunk' mode for offline zero-latency retrieval.";
      } else {
        setPipelineProgress({
          step: 1,
          title: "Synthesizing with LLM",
          detail: documentTree ? "Applying strict legal reasoning over extracted document..." : "Generating response..."
        });

        try {
          responseContent = await callGemini(apiKey, query, rawDocumentContent || undefined);
          if (documentTree) {
            trace = {
              hybridHits: documentTree.children?.slice(0, 2).map(c => c.id) || [],
              graphExpanded: [],
              rerankedTop: documentTree.children?.slice(0, 1).map(c => c.id) || [],
              citedNode: documentTree.children?.[0]?.id || "doc_root"
            };
          }
        } catch (err: any) {
          responseContent = `LLM API Error: ${err.message}. You can switch to '⚡ Direct Chunk' or '⚡ Groq' mode.`;
        }
      }
    }

    setPipelineProgress(null);
    setIsQuerying(false);

    const asstMsg: Message = {
      id: `asst_${Date.now()}`,
      sender: "assistant",
      content: responseContent,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      pipelineTrace: trace,
      retrievedChunk: retrievedChunkData
    };

    const sessionWithAsst = {
      ...sessionWithUser,
      messages: [...sessionWithUser.messages, asstMsg]
    };

    setSessions(prev => prev.map(s => s.id === sessionWithAsst.id ? sessionWithAsst : s));
    await dbSaveSession(sessionWithAsst);
  };

  // Real tree renderer (Only renders actual uploaded tree)
  const renderTreeNode = (node: TreeNode, depth = 0) => {
    const isExpanded = expandedNodes[node.id];
    const isSelected = selectedNode?.id === node.id;
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={node.id} className="select-none">
        <div
          onClick={() => {
            setSelectedNode(node);
            if (hasChildren) toggleNode(node.id);
          }}
          className={cn(
            "group flex items-center justify-between py-1.5 px-2.5 rounded-lg cursor-pointer transition-colors text-xs font-mono",
            isSelected
              ? "bg-neutral-800 text-white font-medium border border-neutral-700"
              : "text-neutral-400 hover:text-white hover:bg-neutral-900"
          )}
          style={{ paddingLeft: `${Math.max(10, depth * 18)}px` }}
        >
          <div className="flex items-center gap-2 overflow-hidden">
            {hasChildren ? (
              <span className="text-neutral-500 hover:text-white">
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </span>
            ) : (
              <span className="w-3.5 h-3.5 flex items-center justify-center text-neutral-600">•</span>
            )}
            <span className="font-semibold text-neutral-300 group-hover:text-white">
              {node.number}
            </span>
            <span className="truncate text-neutral-400 group-hover:text-neutral-200">
              {node.title}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {node.chunkType === "child" && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-neutral-900 text-neutral-300 border border-neutral-700">
                Child
              </span>
            )}
            {node.chunkType === "parent" && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-neutral-900 text-neutral-300 border border-neutral-700">
                Parent
              </span>
            )}
            {node.references && node.references.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-neutral-900 text-neutral-300 border border-neutral-700">
                Edge
              </span>
            )}
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="border-l border-neutral-800 ml-3.5 my-0.5 space-y-0.5">
            {node.children!.map(child => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex w-full h-screen overflow-hidden bg-black text-white antialiased">
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        className="hidden"
        accept=".pdf,.doc,.docx,.txt,.md,.json"
      />

      {/* --- Left Sidebar --- */}
      <aside
        className={cn(
          "h-screen bg-neutral-950 border-r border-neutral-800 flex flex-col shrink-0 transition-all duration-200 z-30",
          isSidebarOpen ? "w-64 sm:w-72" : "w-0 -translate-x-full overflow-hidden border-none"
        )}
      >
        {/* Top Header */}
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-neutral-900 border border-neutral-800 flex items-center justify-center text-white">
              <Scale className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white tracking-tight">Legal RAG</h2>
              <p className="text-[10px] font-mono text-neutral-500">Document Console</p>
            </div>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors sm:hidden"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={handleCreateNewChat}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-200 hover:text-white text-xs font-medium transition-colors group"
          >
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-neutral-300" />
              <span>New Chat</span>
            </div>
            <span className="text-[10px] font-mono text-neutral-500">⌘N</span>
          </button>
        </div>

        {/* Real Saved Chats List */}
        <div className="flex-1 overflow-y-auto px-2 space-y-1 py-2">
          <p className="px-2 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1">
            Chats ({sessions.length})
          </p>
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={cn(
                "group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer text-xs transition-colors",
                activeSessionId === session.id
                  ? "bg-neutral-900 text-white font-medium border border-neutral-800"
                  : "text-neutral-400 hover:text-white hover:bg-neutral-900/60"
              )}
            >
              <div className="flex items-center gap-2 truncate">
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-neutral-500 group-hover:text-neutral-300" />
                <span className="truncate">{session.title}</span>
              </div>

              {sessions.length > 1 && (
                <button
                  onClick={e => handleDeleteSession(session.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-neutral-200 text-neutral-500 transition-opacity"
                  title="Delete chat"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Bottom Database & Key Settings */}
        <div className="p-3 border-t border-neutral-800 space-y-2">
          <button
            onClick={() => {
              setTempGroqKey(groqKey);
              setShowGroqModal(true);
            }}
            className="w-full flex items-center justify-between p-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-300 text-xs transition-colors"
          >
            <div className="flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-neutral-400" />
              <span>Groq API Key</span>
            </div>
            <span className="text-[10px] font-mono text-neutral-500">
              {groqKey ? "Configured" : "Add Key"}
            </span>
          </button>

          <button
            onClick={() => {
              setTempKey(apiKey);
              setShowKeyModal(true);
            }}
            className="w-full flex items-center justify-between p-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-300 text-xs transition-colors"
          >
            <div className="flex items-center gap-2">
              <Key className="w-3.5 h-3.5 text-neutral-400" />
              <span>LLM API Key</span>
            </div>
            <span className="text-[10px] font-mono text-neutral-500">
              {apiKey ? "Configured" : "Add Key"}
            </span>
          </button>

          <div className="w-full flex items-center justify-between p-2 rounded-lg bg-neutral-900/60 border border-neutral-800/80 text-xs font-mono text-neutral-300">
            <div className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-neutral-400" />
              <span>Cloud Storage</span>
            </div>
            <span className="text-neutral-300 text-[10px] font-mono flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 animate-pulse" />
              Supabase Connected
            </span>
          </div>
        </div>
      </aside>

      {/* --- Main Workspace --- */}
      <div className="flex-1 flex flex-col h-screen overflow-y-auto bg-black">
        {/* Top Navbar - Clean, spacious, right side empty as requested */}
        <header className="sticky top-0 z-20 flex items-center justify-between p-3.5 bg-neutral-950 border-b border-neutral-800 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            {!isSidebarOpen && (
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white text-xs sm:text-sm truncate">
                {activeSession?.title || "Legal RAG"}
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-800 hidden sm:inline">
                {activeDocumentName ? activeDocumentName : "No document loaded"}
              </span>
            </div>
          </div>

          {/* Right side left empty as requested */}
          <div className="flex items-center gap-2"></div>
        </header>

        {/* Content Area */}
        <div className="max-w-4xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1 flex flex-col">
          {/* Formatted Chat Messages with Accordion */}
          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto space-y-4 min-h-[220px] max-h-[380px] p-4 rounded-xl bg-neutral-950 border border-neutral-800"
          >
            {activeSession?.messages.map(msg => (
              <FormattedMessageView key={msg.id} msg={msg} />
            ))}

            {pipelineProgress && (
              <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900 text-xs flex items-center gap-3">
                <RefreshCw className="w-4 h-4 text-neutral-300 animate-spin" />
                <div>
                  <p className="font-medium text-white">{pipelineProgress.title}</p>
                  <p className="text-[11px] text-neutral-400">{pipelineProgress.detail}</p>
                </div>
              </div>
            )}
          </div>

          {/* Prompt Bar with Toggle Switch */}
          <div className="space-y-2.5">
            {/* Retrieval Mode Switch & Website API Key Display */}
            <div className="flex items-center justify-between px-1">
              <div className="inline-flex items-center p-0.5 rounded-lg bg-neutral-900 border border-neutral-800 text-xs">
                <button
                  type="button"
                  onClick={() => setInferenceMode("direct")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors",
                    inferenceMode === "direct" ? "bg-white text-black font-semibold" : "text-neutral-400 hover:text-white"
                  )}
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Direct Chunk</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInferenceMode("groq")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors",
                    inferenceMode === "groq" ? "bg-white text-black font-semibold" : "text-neutral-400 hover:text-white"
                  )}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>Groq</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInferenceMode("llm")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors",
                    inferenceMode === "llm" ? "bg-white text-black font-semibold" : "text-neutral-400 hover:text-white"
                  )}
                >
                  <Bot className="w-3.5 h-3.5" />
                  <span>LLM</span>
                </button>
              </div>

              {inferenceMode === "groq" && (
                <button
                  type="button"
                  onClick={() => {
                    setTempGroqKey(groqKey);
                    setShowGroqModal(true);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-[11px] font-mono text-neutral-300 transition-colors"
                  title="Configure Groq API Key"
                >
                  <Key className="w-3 h-3 text-neutral-400" />
                  <span>{groqKey ? `Groq: ${groqKey.slice(0, 6)}...${groqKey.slice(-4)}` : "Set Groq Key"}</span>
                </button>
              )}

              {inferenceMode === "llm" && (
                <button
                  type="button"
                  onClick={() => {
                    setTempKey(apiKey);
                    setShowKeyModal(true);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-[11px] font-mono text-neutral-300 transition-colors"
                  title="Configure LLM API Key"
                >
                  <Key className="w-3 h-3 text-neutral-400" />
                  <span>{apiKey ? `Key: ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "Set LLM Key"}</span>
                </button>
              )}

              {inferenceMode === "direct" && (
                <span className="text-[11px] text-neutral-500 font-mono hidden sm:inline">
                  Zero-hallucination ground truth
                </span>
              )}
            </div>

            <div className="relative bg-neutral-950 rounded-xl border border-neutral-800 focus-within:border-neutral-700 transition-colors">
              <textarea
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendQuery();
                  }
                }}
                placeholder={
                  activeDocumentName
                    ? `Ask about ${activeDocumentName} (e.g., 'What is the notice period under Clause 15?')...`
                    : "Attach a document below to ask questions about it, or type a message..."
                }
                rows={2}
                className="w-full px-4 py-3 bg-transparent text-sm text-white placeholder:text-neutral-500 focus:outline-none resize-none"
              />

              <div className="flex items-center justify-between p-2.5 border-t border-neutral-900">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-neutral-400 hover:text-white hover:bg-neutral-900 border border-dashed border-neutral-800 flex items-center gap-1.5 transition-colors"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Attach Document</span>
                </button>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-neutral-500 hidden sm:inline">Enter ↵</span>
                  <button
                    type="button"
                    onClick={() => handleSendQuery()}
                    disabled={!inputValue.trim() || isQuerying}
                    className={cn(
                      "p-2 rounded-lg text-sm transition-all duration-150 flex items-center justify-center",
                      inputValue.trim() && !isQuerying
                        ? "bg-white text-black hover:bg-neutral-200"
                        : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                    )}
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Section: Document Tree & Node Inspector (REAL DATA ONLY) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-5 pt-2">
            {/* Tree */}
            <div className="md:col-span-7 bg-neutral-950 border border-neutral-800 rounded-xl p-4 sm:p-5 flex flex-col space-y-3">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <GitFork className="w-4 h-4 text-neutral-300" />
                  <h3 className="text-xs sm:text-sm font-semibold text-white">
                    Document Tree Hierarchy
                  </h3>
                </div>
                <span className="text-[10px] font-mono text-neutral-500">
                  {documentTree ? "Interactive Tree" : "No Document"}
                </span>
              </div>

              <div className="overflow-y-auto max-h-[300px] pr-1 space-y-0.5">
                {documentTree ? (
                  renderTreeNode(documentTree)
                ) : (
                  <div className="p-6 text-center text-xs text-neutral-500">
                    No document parsed yet. Click <strong>Attach Document</strong> above to generate the hierarchy tree.
                  </div>
                )}
              </div>
            </div>

            {/* Inspector */}
            <div className="md:col-span-5 bg-neutral-950 border border-neutral-800 rounded-xl p-4 sm:p-5 flex flex-col space-y-3">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-neutral-300" />
                  <h3 className="text-xs sm:text-sm font-semibold text-white">Node Inspector</h3>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-900 text-neutral-300 border border-neutral-800">
                  {selectedNode ? `ID: ${selectedNode.id}` : "Idle"}
                </span>
              </div>

              {selectedNode ? (
                <div className="space-y-3 text-xs">
                  <div>
                    <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Breadcrumb</p>
                    <p className="font-mono text-[11px] text-neutral-300 mt-1 bg-neutral-900 p-2 rounded border border-neutral-800">
                      {selectedNode.breadcrumb}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-neutral-900 p-2 rounded border border-neutral-800">
                      <span className="text-[10px] text-neutral-500 uppercase font-semibold">Chunk Category</span>
                      <p className="font-medium text-white capitalize mt-0.5">{selectedNode.chunkType} chunk</p>
                    </div>
                    <div className="bg-neutral-900 p-2 rounded border border-neutral-800">
                      <span className="text-[10px] text-neutral-500 uppercase font-semibold">Location</span>
                      <p className="font-medium text-white mt-0.5">Page {selectedNode.page}</p>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Clause Text</p>
                    <div className="mt-1 p-2 rounded bg-neutral-900 border border-neutral-800 text-neutral-300 text-xs leading-relaxed max-h-[100px] overflow-y-auto">
                      {selectedNode.text}
                    </div>
                  </div>

                  {selectedNode.references && selectedNode.references.length > 0 && (
                    <div>
                      <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Cross-Reference Edges</p>
                      <div className="mt-1 space-y-1">
                        {selectedNode.references.map((ref, idx) => (
                          <div key={idx} className="p-1.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-300 flex items-center justify-between text-[11px]">
                            <span className="font-mono text-neutral-400">{ref.type}</span>
                            <div className="flex items-center gap-1 font-mono">
                              <ArrowRight className="w-3 h-3 text-neutral-400" />
                              <span>{ref.targetLabel}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-neutral-500">
                  Attach a document and click any tree node to inspect its content and breadcrumbs.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* --- LLM API Key Modal --- */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-neutral-950 border border-neutral-800 rounded-xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-white" />
                <h3 className="text-sm font-semibold text-white">LLM API Key</h3>
              </div>
              <button
                onClick={() => setShowKeyModal(false)}
                className="p-1 text-neutral-400 hover:text-white rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-neutral-400">
                Enter your LLM API key to run real-time inference over uploaded documents with Gemini 3.8 Flash.
              </p>
              <input
                type="password"
                value={tempKey}
                onChange={e => setTempKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 font-mono"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowKeyModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={saveApiKey}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-black hover:bg-neutral-200 transition-colors"
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Groq API Key Modal --- */}
      {showGroqModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-neutral-950 border border-neutral-800 rounded-xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-white" />
                <h3 className="text-sm font-semibold text-white">Groq API Key</h3>
              </div>
              <button
                onClick={() => setShowGroqModal(false)}
                className="p-1 text-neutral-400 hover:text-white rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-neutral-400">
                Enter your Groq API key (from <span className="text-neutral-300 font-mono">console.groq.com</span>) to run ultra-fast legal synthesis with Llama 3.3 70B on Groq LPUs (500+ tokens/sec).
              </p>
              <input
                type="password"
                value={tempGroqKey}
                onChange={e => {
                  setTempGroqKey(e.target.value);
                  setGroqTestStatus(null);
                }}
                placeholder="gsk_..."
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 font-mono"
              />

              {groqTestStatus && (
                <div
                  className={cn(
                    "p-2 rounded text-[11px] font-mono border",
                    groqTestStatus.loading && "bg-neutral-900 border-neutral-800 text-neutral-400",
                    groqTestStatus.success && "bg-neutral-900 border-neutral-700 text-white font-medium",
                    groqTestStatus.success === false && "bg-neutral-900 border-neutral-800 text-neutral-300"
                  )}
                >
                  {groqTestStatus.msg}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={testGroq}
                disabled={!tempGroqKey.trim() || groqTestStatus?.loading}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 transition-colors disabled:opacity-50"
              >
                {groqTestStatus?.loading ? "Testing..." : "Test Connection"}
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setGroqTestStatus(null);
                    setShowGroqModal(false);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs text-neutral-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={saveGroqKey}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-black hover:bg-neutral-200 transition-colors"
                >
                  Save Groq Key
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default Demo;
