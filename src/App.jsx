import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ChevronLeft, ChevronRight, Plus, X, Users, Calendar, MapPin,
  Circle, CheckCircle2, Send, Stamp, FileText, Lock,
  Wallet, ListChecks, Eye, Building2, Truck, Printer, Mail, Phone,
  MessageCircle, ImagePlus
} from "lucide-react";
import {
  supabase, supabaseConfigured,
  signInPlanner, signOut as sbSignOut, getCurrentPlanner,
  requestClientMagicLink, getCurrentClientEvent,
  fetchEvents as sbFetchEvents, fetchEventDetail,
  toggleTask as sbToggleTask, assignTask as sbAssignTask,
  submitProposalForReview as sbSubmitProposalForReview,
  approveAndSendProposal as sbApproveAndSendProposal,
  rejectProposalToDraft as sbRejectProposalToDraft,
  clientApproveProposal as sbClientApproveProposal,
  clientDisapproveProposal as sbClientDisapproveProposal,
  requestApproval as sbRequestApproval,
  releaseApprovalToClient as sbReleaseApprovalToClient,
  clientApproveMilestone as sbClientApproveMilestone, clientDisapproveMilestone as sbClientDisapproveMilestone,
  sendMessage as sbSendMessage,
  addVendor as sbAddVendor, cycleVendorStatus as sbCycleVendorStatus, updateVendorPhone as sbUpdateVendorPhone,
  createEvent as sbCreateEvent, inviteClient as sbInviteClient,
  invitePlanner, fetchTeamMembers, updatePlannerRole, removePlanner,
  generateClientCode, redeemClientCode, subscribeToActivity,
  deleteEvent as sbDeleteEvent, addTask as sbAddTask, deleteTask as sbDeleteTask,
  requestTask as sbRequestTask, dismissTaskRequest as sbDismissTaskRequest, approveTaskRequest as sbApproveTaskRequest,
  addProposalItem as sbAddProposalItem, updateProposalItem as sbUpdateProposalItem, deleteProposalItem as sbDeleteProposalItem,
} from "./lib/supabaseClient";
import { assembleEventFromSupabase } from "./lib/adapter";

/* ---------------------------------------------------------------
   DOSSIER — event production studio + client approval portal
   Ink / paper / brass — the paper trail of event production
----------------------------------------------------------------*/

const COLORS = {
  paper: "#F8F8F6",
  paperDeep: "#EFEFEC",
  card: "#FFFFFF",
  ink: "#161616",
  inkSoft: "#5A5A54",
  inkFaint: "#8C8C86",
  brass: "#D91E4B",
  brassDeep: "#A01238",
  brassPale: "#FBDCE4",
  clay: "#C2410C",
  clayDeep: "#8A2E08",
  clayPale: "#FCE1D0",
  line: "rgba(22,22,22,0.12)",
};

const FONT_DISPLAY = "'Newsreader', serif";
const FONT_BODY = "'IBM Plex Sans', sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;1,400;1,500&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');`;

/* ---------------- Helpers ---------------- */

function currency(n) {
  return "₦" + n.toLocaleString("en-NG");
}

function progressOf(event) {
  const all = event.phases.flatMap((p) => p.tasks);
  if (all.length === 0) return 0;
  return Math.round((all.filter((t) => t.done).length / all.length) * 100);
}

function today() {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTimestamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/* ---------------- Input hardening ----------------
 * Client-side validation is a UX/abuse-reduction measure, not a security
 * boundary — a determined attacker can always bypass JS running in their
 * own browser. Real enforcement of these same limits must also happen
 * server-side once this is backed by a real API (see BitAffairs-Auth-Spec.md).
 * What this DOES genuinely protect against: accidental storage bloat,
 * pasted-in walls of text breaking layout, and a basic minimum bar before
 * data is trusted enough to render or persist.
 */
const LIMITS = {
  shortText: 120,   // names, labels
  longText: 500,    // descriptions
  message: 2000,    // chat messages
  maxImageBytes: 15 * 1024 * 1024, // 15MB — reject before ever reading into memory
};

function clampText(str, maxLen) {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, maxLen);
}

function isPlausibleEmail(str) {
  // Deliberately simple — real validation (MX lookup, confirmation email)
  // belongs server-side. This just catches obvious typos in the UI.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
}

/**
 * Reads an image file, downsizes it, and returns a compressed base64 JPEG
 * data URL. Necessary because shared images end up stored as text in the
 * database (the messages.image_url column) — an un-resized phone photo
 * would be needlessly large stored that way.
 */
function resizeImageFile(file, maxDim = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not read that image."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

/* ---------------- Small building blocks ---------------- */

function Eyebrow({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_BODY,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: COLORS.brassDeep,
      }}
    >
      {children}
    </div>
  );
}

function StatusTag({ status }) {
  const map = {
    "In production": { bg: COLORS.brassPale, fg: COLORS.brassDeep },
    "Final stretch": { bg: COLORS.clayPale, fg: COLORS.clayDeep },
    "Early planning": { bg: COLORS.line, fg: COLORS.inkSoft },
    "Awaiting approval": { bg: COLORS.clayPale, fg: COLORS.clayDeep },
    "Changes requested": { bg: COLORS.clay, fg: COLORS.card },
  };
  const s = map[status] || map["Early planning"];
  return (
    <span
      style={{
        fontFamily: FONT_BODY,
        fontSize: 11,
        fontWeight: 600,
        padding: "4px 10px",
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}

function ProgressRing({ pct, size = 56 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLORS.line} strokeWidth="5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={COLORS.brass}
        strokeWidth="5"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontFamily: FONT_MONO, fontSize: size * 0.24, fontWeight: 500, fill: COLORS.ink }}
      >
        {pct}%
      </text>
    </svg>
  );
}

/* Signature element: the brass approval stamp */
function StampButton({ approved, approvedAt, onApprove, size = "md" }) {
  const [stamping, setStamping] = useState(false);
  const dim = size === "lg" ? 88 : 64;

  const handleClick = () => {
    if (approved || stamping) return;
    setStamping(true);
    setTimeout(() => {
      setStamping(false);
      onApprove();
    }, 420);
  };

  return (
    <button
      onClick={handleClick}
      disabled={approved}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        background: "none",
        border: "none",
        cursor: approved ? "default" : "pointer",
        padding: 0,
      }}
    >
      <div
        style={{
          width: dim,
          height: dim,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `2.5px solid ${approved ? COLORS.brass : COLORS.inkFaint}`,
          background: approved ? COLORS.brassPale : "transparent",
          transform: stamping ? "scale(0.86)" : "scale(1)",
          transition: "transform 0.18s ease, border-color 0.2s ease, background 0.2s ease",
        }}
      >
        <Stamp size={dim * 0.36} color={approved ? COLORS.brassDeep : COLORS.inkFaint} strokeWidth={1.5} />
      </div>
      <span
        style={{
          fontFamily: FONT_BODY,
          fontSize: 12,
          fontWeight: 600,
          color: approved ? COLORS.brassDeep : COLORS.inkSoft,
          textAlign: "center",
        }}
      >
        {approved ? `Approved ${formatTimestamp(approvedAt) || today()}` : "Press to approve"}
      </span>
    </button>
  );
}

function DisapproveStampButton({ onDisapprove, size = "md" }) {
  const [stamping, setStamping] = useState(false);
  const dim = size === "lg" ? 88 : 64;

  const handleClick = () => {
    if (stamping) return;
    setStamping(true);
    setTimeout(() => {
      setStamping(false);
      onDisapprove();
    }, 420);
  };

  return (
    <button
      onClick={handleClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <div
        style={{
          width: dim,
          height: dim,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `2.5px solid ${COLORS.clay}`,
          background: "transparent",
          transform: stamping ? "scale(0.86)" : "scale(1)",
          transition: "transform 0.18s ease, background 0.2s ease",
        }}
      >
        <X size={dim * 0.36} color={COLORS.clayDeep} strokeWidth={2} />
      </div>
      <span
        style={{
          fontFamily: FONT_BODY,
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.clayDeep,
          textAlign: "center",
        }}
      >
        Request changes
      </span>
    </button>
  );
}

function SectionCard({ children, style }) {
  return (
    <div
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.line}`,
        borderRadius: 4,
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h2
      style={{
        fontFamily: FONT_DISPLAY,
        fontStyle: "italic",
        fontWeight: 500,
        fontSize: 22,
        color: COLORS.ink,
        margin: "0 0 16px",
      }}
    >
      {children}
    </h2>
  );
}

/* ---------------- Phase / task checklist ---------------- */

function assigneeColor(name, team) {
  const idx = Math.max(0, team.findIndex((t) => t.startsWith(name)));
  const palette = [COLORS.brass, COLORS.clay, COLORS.inkSoft];
  return palette[idx % palette.length];
}

function AddTaskRow({ onAdd, teamMembers }) {
  const [label, setLabel] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [appointed, setAppointed] = useState([]);

  const submit = () => {
    if (!label.trim()) return;
    onAdd(clampText(label, LIMITS.shortText), {
      visibility: restricted ? "restricted" : "team",
      assigneePlannerIds: restricted ? appointed : [],
    });
    setLabel("");
    setRestricted(false);
    setAppointed([]);
  };

  const toggleAppointed = (id) => {
    setAppointed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div style={{ marginTop: 8, marginBottom: 4 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !restricted && submit()}
          placeholder="Add a task…"
          style={{
            flex: 1, fontFamily: FONT_BODY, fontSize: 13, padding: "7px 10px",
            border: `1px dashed ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
          }}
        />
        <button
          onClick={submit}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 30, borderRadius: 4,
            border: "none", background: COLORS.brass, color: COLORS.ink, cursor: "pointer", flexShrink: 0,
          }}
        >
          <Plus size={15} />
        </button>
      </div>
      {teamMembers && teamMembers.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, cursor: "pointer" }}>
            <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
            Private task — only admins and appointed team members can see this
          </label>
          {restricted && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 22 }}>
              {teamMembers.map((m) => (
                <label
                  key={m.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, fontFamily: FONT_BODY, fontSize: 12,
                    color: COLORS.inkSoft, cursor: "pointer", padding: "3px 8px", borderRadius: 999,
                    border: `1px solid ${COLORS.line}`, background: appointed.includes(m.id) ? COLORS.brassPale : "transparent",
                  }}
                >
                  <input type="checkbox" checked={appointed.includes(m.id)} onChange={() => toggleAppointed(m.id)} style={{ margin: 0 }} />
                  {m.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseChecklist({ phases, editable, isAdmin, onToggleTask, team, teamMembers, onAssign, onAddTask, onDeleteTask }) {
  return (
    <div>
      {phases.map((phase, pi) => (
        <div key={phase.id} style={{ marginBottom: 22 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              marginBottom: 10,
              paddingBottom: 8,
              borderBottom: `1px solid ${COLORS.line}`,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: COLORS.brassDeep,
                fontWeight: 500,
              }}
            >
              {String(pi + 1).padStart(2, "0")}
            </span>
            <h3
              style={{
                fontFamily: FONT_BODY,
                fontSize: 14,
                fontWeight: 700,
                color: COLORS.ink,
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              {phase.title}
            </h3>
          </div>
          {phase.tasks.length === 0 && (
            <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, padding: "4px 4px 8px" }}>
              No tasks yet.
            </div>
          )}
          {phase.tasks.map((task) => (
            <div
              key={task.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "8px 4px",
                borderRadius: 4,
              }}
            >
              <div
                onClick={() => editable && onToggleTask(phase.id, task.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: editable ? "pointer" : "default",
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {task.done ? (
                  <CheckCircle2 size={17} color={COLORS.brass} strokeWidth={2} />
                ) : (
                  <Circle size={17} color={COLORS.inkFaint} strokeWidth={1.5} />
                )}
                {task.visibility === "restricted" && (
                  <Lock size={12} color={COLORS.inkFaint} title="Private — only admins and appointed team members can see this" />
                )}
                <span
                  style={{
                    fontFamily: FONT_BODY,
                    fontSize: 14,
                    color: task.done ? COLORS.inkFaint : COLORS.ink,
                    textDecoration: task.done ? "line-through" : "none",
                  }}
                >
                  {task.label}
                </span>
              </div>
              {task.assignee && (
                <button
                  onClick={() => editable && team && onAssign && onAssign(phase.id, task.id)}
                  title={editable && team ? "Click to reassign" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    background: "none",
                    border: `1px solid ${COLORS.line}`,
                    borderRadius: 999,
                    padding: "3px 10px 3px 8px",
                    cursor: editable && team ? "pointer" : "default",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: team ? assigneeColor(task.assignee, team) : COLORS.brass,
                    }}
                  />
                  <span style={{ fontFamily: FONT_BODY, fontSize: 11, fontWeight: 600, color: COLORS.inkSoft }}>
                    {task.assignee}
                  </span>
                </button>
              )}
              {isAdmin && onDeleteTask && (
                <button
                  onClick={() => onDeleteTask(phase.id, task.id)}
                  title="Delete task"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22,
                    background: "none", border: "none", color: COLORS.inkFaint, cursor: "pointer", flexShrink: 0,
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {isAdmin && onAddTask && (
            <AddTaskRow onAdd={(label, options) => onAddTask(phase.id, label, options)} teamMembers={teamMembers} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Proposal ---------------- */

const proposalFieldStyle = {
  fontFamily: FONT_BODY, fontSize: 13, padding: "7px 9px",
  border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
};

function ProposalItemRow({ item, onUpdate, onDelete }) {
  const [label, setLabel] = useState(item.label);
  const [qty, setQty] = useState(item.qty);
  const [unitCost, setUnitCost] = useState(item.unitCost);

  const commit = () => {
    const patch = {
      label: clampText(label, LIMITS.shortText) || item.label,
      qty: Math.max(1, Number(qty) || 1),
      unitCost: Math.max(0, Number(unitCost) || 0),
    };
    setQty(patch.qty);
    setUnitCost(patch.unitCost);
    if (patch.label !== item.label || patch.qty !== item.qty || patch.unitCost !== item.unitCost) {
      onUpdate(patch);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${COLORS.line}`, flexWrap: "wrap" }}>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        style={{ ...proposalFieldStyle, flex: 1, minWidth: 140 }}
      />
      <input
        type="number"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        onBlur={commit}
        title="Quantity"
        style={{ ...proposalFieldStyle, width: 52 }}
      />
      <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkFaint }}>×</span>
      <input
        type="number"
        value={unitCost}
        onChange={(e) => setUnitCost(e.target.value)}
        onBlur={commit}
        title="Unit cost"
        style={{ ...proposalFieldStyle, width: 110 }}
      />
      <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: COLORS.inkSoft, minWidth: 90, textAlign: "right" }}>
        {currency(qty * unitCost)}
      </span>
      <button
        onClick={onDelete}
        title="Remove item"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, background: "none", border: "none", color: COLORS.inkFaint, cursor: "pointer" }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ProposalItemsEditor({ items, onAddItem, onUpdateItem, onDeleteItem }) {
  const [newLabel, setNewLabel] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [newCost, setNewCost] = useState("");

  const addItem = () => {
    if (!newLabel.trim()) return;
    onAddItem({
      label: clampText(newLabel, LIMITS.shortText),
      qty: Math.max(1, Number(newQty) || 1),
      unitCost: Math.max(0, Number(newCost) || 0),
    });
    setNewLabel("");
    setNewQty(1);
    setNewCost("");
  };

  return (
    <div style={{ marginBottom: 18 }}>
      {items.length === 0 && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, padding: "8px 0" }}>
          No line items yet — add the scope of work below.
        </div>
      )}
      {items.map((item) => (
        <ProposalItemRow
          key={item.id}
          item={item}
          onUpdate={(patch) => onUpdateItem(item.id, patch)}
          onDelete={() => onDeleteItem(item.id)}
        />
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="Add a line item…"
          style={{ ...proposalFieldStyle, flex: 1, minWidth: 140, borderStyle: "dashed" }}
        />
        <input
          type="number"
          value={newQty}
          onChange={(e) => setNewQty(e.target.value)}
          title="Quantity"
          style={{ ...proposalFieldStyle, width: 52, borderStyle: "dashed" }}
        />
        <input
          type="number"
          value={newCost}
          onChange={(e) => setNewCost(e.target.value)}
          placeholder="Cost"
          title="Unit cost"
          style={{ ...proposalFieldStyle, width: 110, borderStyle: "dashed" }}
        />
        <button
          onClick={addItem}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 4,
            border: "none", background: COLORS.brass, color: COLORS.ink, cursor: "pointer",
          }}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

function ProposalView({ proposal, editable, isAdmin, onSubmitReview, onSend, onReject, onReset, onApprove, onDisapprove, onOpenDocument, onAddItem, onUpdateItem, onDeleteItem }) {
  const total = proposal.items.reduce((s, i) => s + i.qty * i.unitCost, 0);
  const badgeStatus =
    proposal.status === "approved" ? "Final stretch"
    : proposal.status === "disapproved" ? "Changes requested"
    : proposal.status === "sent" ? "In production"
    : proposal.status === "pending_review" ? "Awaiting approval"
    : "Early planning";
  const isEditableNow = editable && (isAdmin || proposal.status === "draft" || proposal.status === "disapproved" || proposal.status === "approved");
  return (
    <SectionCard>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <SectionTitle>Proposal</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {editable && onOpenDocument && (
            <button
              onClick={onOpenDocument}
              style={{
                display: "flex", alignItems: "center", gap: 6, background: "none",
                border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: "6px 12px",
                color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}
            >
              <Printer size={13} /> Proposal document
            </button>
          )}
          {isAdmin && editable && proposal.status !== "draft" && onReset && (
            <button
              onClick={() => {
                if (window.confirm("Reset this proposal to draft? This clears its sent/approval status so it can be rebuilt.")) {
                  onReset();
                }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 6, background: "none",
                border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: "6px 12px",
                color: COLORS.clayDeep, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}
            >
              <X size={13} /> Reset to draft
            </button>
          )}
          <StatusTag status={badgeStatus} />
        </div>
      </div>
      {proposal.status === "disapproved" && editable && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, background: COLORS.clayPale, borderRadius: 4, padding: "10px 12px", marginBottom: 14 }}>
          The client requested changes to this proposal. Edit the scope below, then resubmit.
        </div>
      )}
      {proposal.status === "approved" && editable && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkFaint, marginBottom: 10 }}>
          Editing an approved proposal will pull it back into review — the client will need to approve the revised version.
        </div>
      )}
      {isEditableNow && onAddItem ? (
        <ProposalItemsEditor
          items={proposal.items}
          onAddItem={onAddItem}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
        />
      ) : (
        <div style={{ marginBottom: 18 }}>
          {proposal.items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "12px 0",
                borderBottom: `1px solid ${COLORS.line}`,
                fontFamily: FONT_BODY,
                fontSize: 14,
                color: COLORS.ink,
              }}
            >
              <span>{item.label}</span>
              <span style={{ fontFamily: FONT_MONO, color: COLORS.inkSoft }}>{currency(item.qty * item.unitCost)}</span>
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "14px 0 0",
          fontFamily: FONT_BODY,
          fontSize: 15,
          fontWeight: 700,
          color: COLORS.ink,
        }}
      >
        <span>Total</span>
        <span style={{ fontFamily: FONT_MONO }}>{currency(total)}</span>
      </div>

      {editable && (proposal.status === "draft" || proposal.status === "disapproved") && (
        isAdmin ? (
          <button
            onClick={onSend}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 4,
              border: "none", background: COLORS.ink, color: COLORS.paper,
              fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer", marginTop: 14,
            }}
          >
            <Send size={14} /> {proposal.status === "disapproved" ? "Resend to client" : "Send to client"}
          </button>
        ) : (
          <button
            onClick={onSubmitReview}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 4,
              border: "none", background: COLORS.ink, color: COLORS.paper,
              fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer", marginTop: 14,
            }}
          >
            <Send size={14} /> {proposal.status === "disapproved" ? "Resubmit for admin review" : "Submit for admin review"}
          </button>
        )
      )}
      {editable && proposal.status === "pending_review" && (
        isAdmin ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
            <button
              onClick={onSend}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 4,
                border: "none", background: COLORS.brass, color: COLORS.ink,
                fontFamily: FONT_BODY, fontWeight: 700, fontSize: 13, cursor: "pointer",
              }}
            >
              <Stamp size={14} /> Approve &amp; send to client
            </button>
            <button
              onClick={onReject}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 4,
                border: `1px solid ${COLORS.line}`, background: "transparent", color: COLORS.inkSoft,
                fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer",
              }}
            >
              Send back to draft
            </button>
          </div>
        ) : (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 14 }}>
            Submitted for review — waiting on admin approval before it goes to the client.
          </div>
        )
      )}
      {editable && proposal.status === "sent" && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 14 }}>
          Sent {formatTimestamp(proposal.sentAt)} · awaiting client response
        </div>
      )}
      {editable && proposal.status === "approved" && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.brassDeep, fontWeight: 600, marginTop: 14 }}>
          Approved by client on {formatTimestamp(proposal.approvedAt)}
        </div>
      )}

      {!editable && proposal.status === "sent" && (
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 8, flexWrap: "wrap" }}>
          <StampButton approved={false} onApprove={onApprove} />
          <DisapproveStampButton onDisapprove={onDisapprove} />
          <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, maxWidth: 260 }}>
            Review the scope above, then approve or request changes.
          </span>
        </div>
      )}
      {!editable && proposal.status === "approved" && (
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 8 }}>
          <StampButton approved={true} approvedAt={proposal.approvedAt} onApprove={() => {}} />
        </div>
      )}
      {!editable && proposal.status === "disapproved" && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, marginTop: 8 }}>
          You requested changes on {formatTimestamp(proposal.disapprovedAt)}. Your planner has been notified and will follow up with a revised proposal.
        </div>
      )}
      {!editable && proposal.status === "draft" && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint }}>
          Your planner is still preparing this proposal.
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Approvals ---------------- */

function ApprovalsList({ approvals, editable, isAdmin, onApprove, onDisapprove, onRequest, onRelease }) {
  const [label, setLabel] = useState("");
  const [desc, setDesc] = useState("");

  const submit = () => {
    if (!label.trim()) return;
    onRequest(clampText(label, LIMITS.shortText), clampText(desc, LIMITS.longText));
    setLabel("");
    setDesc("");
  };

  return (
    <SectionCard>
      <SectionTitle>Approvals</SectionTitle>
      {approvals.length === 0 && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, marginBottom: 16 }}>
          No approvals requested yet.
        </div>
      )}
      {approvals.map((a) => (
        <div
          key={a.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            padding: "16px 0",
            borderBottom: `1px solid ${COLORS.line}`,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.ink }}>{a.label}</div>
            <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 2 }}>{a.description}</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.inkFaint, marginTop: 4 }}>
              Requested {formatTimestamp(a.requestedAt)}
            </div>
            {!editable && a.status === "disapproved" && (
              <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, marginTop: 6 }}>
                You requested changes on {formatTimestamp(a.disapprovedAt)}. Your planner has been notified.
              </div>
            )}
          </div>
          {editable ? (
            a.status === "pending_review" ? (
              isAdmin ? (
                <button
                  onClick={() => onRelease(a.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999,
                    border: "none", background: COLORS.brass, color: COLORS.ink,
                    fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  <Stamp size={12} /> Release to client
                </button>
              ) : (
                <StatusTag status="Awaiting approval" />
              )
            ) : a.status === "disapproved" ? (
              isAdmin ? (
                <button
                  onClick={() => onRelease(a.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999,
                    border: "none", background: COLORS.brass, color: COLORS.ink,
                    fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  <Stamp size={12} /> Re-release to client
                </button>
              ) : (
                <StatusTag status="Changes requested" />
              )
            ) : (
              <StatusTag status={a.status === "approved" ? "Final stretch" : "In production"} />
            )
          ) : a.status === "disapproved" ? null : (
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <StampButton approved={a.status === "approved"} approvedAt={a.approvedAt} onApprove={() => onApprove(a.id)} />
              {a.status === "pending" && <DisapproveStampButton onDisapprove={() => onDisapprove(a.id)} />}
            </div>
          )}
        </div>
      ))}

      {editable && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px dashed ${COLORS.line}` }}>
          <Eyebrow>Request new approval</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="What needs approval?"
              style={{
                fontFamily: FONT_BODY,
                fontSize: 13,
                padding: "9px 12px",
                border: `1px solid ${COLORS.line}`,
                borderRadius: 4,
                background: COLORS.paper,
                color: COLORS.ink,
                outline: "none",
              }}
            />
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Short description (optional)"
              style={{
                fontFamily: FONT_BODY,
                fontSize: 13,
                padding: "9px 12px",
                border: `1px solid ${COLORS.line}`,
                borderRadius: 4,
                background: COLORS.paper,
                color: COLORS.ink,
                outline: "none",
              }}
            />
            <button
              onClick={submit}
              style={{
                alignSelf: "flex-start",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 4,
                border: "none",
                background: COLORS.brass,
                color: COLORS.ink,
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Plus size={14} /> {isAdmin ? "Send to client" : "Submit for review"}
            </button>
            {!isAdmin && (
              <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.inkFaint }}>
                New requests go to your admin for approval before the client sees them.
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Task requests (client-proposed, admin-resolved) ---------------- */

function TaskRequestsPanel({ requests, phases, isAdmin, onApprove, onDismiss }) {
  const pending = (requests || []).filter((r) => r.status === "pending");
  if (pending.length === 0) return null;

  return (
    <div style={{ marginBottom: 22, padding: "14px 16px", background: COLORS.paperDeep, borderRadius: 6 }}>
      <Eyebrow>{pending.length === 1 ? "1 task requested by client" : `${pending.length} tasks requested by client`}</Eyebrow>
      <div style={{ marginTop: 8 }}>
        {pending.map((r) => (
          <TaskRequestRow key={r.id} request={r} phases={phases} isAdmin={isAdmin} onApprove={onApprove} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}

function TaskRequestRow({ request, phases, isAdmin, onApprove, onDismiss }) {
  const [resolving, setResolving] = useState(false);
  const [phaseId, setPhaseId] = useState(phases[0]?.id || "");
  const [label, setLabel] = useState(request.label);

  const smallInputStyle = {
    fontFamily: FONT_BODY, fontSize: 13, padding: "7px 10px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.card, color: COLORS.ink, outline: "none",
  };

  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${COLORS.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.ink }}>{request.label}</div>
          {request.description && (
            <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 2 }}>{request.description}</div>
          )}
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.inkFaint, marginTop: 4 }}>
            Requested {formatTimestamp(request.requestedAt)}
          </div>
        </div>
        {isAdmin ? (
          !resolving && (
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => setResolving(true)}
                style={{
                  padding: "6px 12px", borderRadius: 999, border: "none", background: COLORS.brass, color: COLORS.ink,
                  fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                }}
              >
                Add to checklist
              </button>
              <button
                onClick={() => onDismiss(request.id)}
                style={{
                  padding: "6px 12px", borderRadius: 999, border: `1px solid ${COLORS.line}`, background: "transparent",
                  color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                }}
              >
                Dismiss
              </button>
            </div>
          )
        ) : (
          <StatusTag status="Awaiting admin" />
        )}
      </div>
      {isAdmin && resolving && (
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)} style={smallInputStyle}>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...smallInputStyle, flex: 1, minWidth: 160 }} />
          <button
            onClick={() => {
              if (!phaseId || !label.trim()) return;
              onApprove(request.id, phaseId, clampText(label, LIMITS.shortText));
              setResolving(false);
            }}
            style={{
              padding: "7px 12px", borderRadius: 4, border: "none", background: COLORS.brass, color: COLORS.ink,
              fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer",
            }}
          >
            Confirm
          </button>
          <button
            onClick={() => setResolving(false)}
            style={{
              padding: "7px 12px", borderRadius: 4, border: `1px solid ${COLORS.line}`, background: "transparent",
              color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Budget ---------------- */

function BudgetView({ budget, vendors }) {
  const vendorSpend = (vendors || []).filter((v) => v.status === "confirmed").reduce((s, v) => s + v.cost, 0);
  const remaining = budget.total - vendorSpend;
  const overBudget = remaining < 0;
  const pct = budget.total > 0 ? Math.round((vendorSpend / budget.total) * 100) : 0;

  return (
    <SectionCard>
      <SectionTitle>Budget</SectionTitle>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontFamily: FONT_BODY }}>
        <span style={{ fontSize: 13, color: COLORS.inkSoft }}>Paid to confirmed vendors {currency(vendorSpend)} of {currency(budget.total)}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: overBudget ? COLORS.clayDeep : COLORS.ink }}>{pct}%</span>
      </div>
      <div style={{ height: 8, background: COLORS.line, borderRadius: 999, overflow: "hidden", marginBottom: 10 }}>
        <div
          style={{
            width: `${Math.min(pct, 100)}%`, height: "100%",
            background: overBudget ? COLORS.clay : COLORS.brass, transition: "width 0.5s ease",
          }}
        />
      </div>
      <div
        style={{
          display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 4,
          background: overBudget ? COLORS.clayPale : COLORS.paper, marginBottom: 20,
          fontFamily: FONT_BODY, fontSize: 13, fontWeight: 700,
        }}
      >
        <span style={{ color: overBudget ? COLORS.clayDeep : COLORS.ink }}>{overBudget ? "Over budget by" : "Remaining"}</span>
        <span style={{ fontFamily: FONT_MONO, color: overBudget ? COLORS.clayDeep : COLORS.ink }}>
          {overBudget ? `-${currency(Math.abs(remaining))}` : currency(remaining)}
        </span>
      </div>
      {budget.items.length > 0 && (
        <>
          <div style={{ fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: COLORS.inkFaint, marginBottom: 8 }}>
            Line items
          </div>
          {budget.items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "10px 0",
                borderBottom: i < budget.items.length - 1 ? `1px solid ${COLORS.line}` : "none",
                fontFamily: FONT_BODY,
                fontSize: 13,
              }}
            >
              <span style={{ color: COLORS.ink }}>{item.label}</span>
              <span style={{ fontFamily: FONT_MONO, color: COLORS.inkSoft }}>
                {currency(item.actual)} / {currency(item.planned)}
              </span>
            </div>
          ))}
        </>
      )}
    </SectionCard>
  );
}

/* ---------------- Vendors ---------------- */

function vendorStatusTag(status) {
  const map = {
    confirmed: { bg: COLORS.brassPale, fg: COLORS.brassDeep, label: "Confirmed" },
    pending: { bg: COLORS.clayPale, fg: COLORS.clayDeep, label: "Pending" },
    inquiry: { bg: COLORS.line, fg: COLORS.inkSoft, label: "Inquiry" },
  };
  return map[status] || map.inquiry;
}

function VendorsView({ vendors, onAddVendor, onCycleStatus, onUpdatePhone, readOnly = false }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    if (!name.trim() || !category.trim()) {
      setError("Vendor name and category are required.");
      return;
    }
    if (contact.trim() && !isPlausibleEmail(contact)) {
      setError("That contact email doesn't look right — double check it.");
      return;
    }
    setError("");
    onAddVendor({
      name: clampText(name, LIMITS.shortText),
      category: clampText(category, LIMITS.shortText),
      contact: clampText(contact, LIMITS.shortText),
      phone: clampText(phone, LIMITS.shortText),
      cost: Math.max(0, Number(cost) || 0),
    });
    setName("");
    setCategory("");
    setContact("");
    setPhone("");
    setCost("");
  };

  const inputStyle = {
    fontFamily: FONT_BODY,
    fontSize: 13,
    padding: "9px 12px",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 4,
    background: COLORS.paper,
    color: COLORS.ink,
    outline: "none",
  };

  return (
    <SectionCard>
      <SectionTitle>Vendors</SectionTitle>
      {vendors.length === 0 && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, marginBottom: 16 }}>
          No vendors added yet.
        </div>
      )}
      {vendors.map((v) => {
        const tag = vendorStatusTag(v.status);
        return (
          <div
            key={v.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              padding: "14px 0",
              borderBottom: `1px solid ${COLORS.line}`,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.ink }}>{v.name}</div>
              <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>{v.category}</div>
              {v.contact && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.inkFaint, marginTop: 4 }}>
                  <Mail size={11} /> {v.contact}
                </div>
              )}
              {(v.phone || !readOnly) && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                  <Phone size={11} color={COLORS.inkFaint} />
                  {readOnly ? (
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.inkFaint }}>{v.phone}</span>
                  ) : (
                    <input
                      defaultValue={v.phone || ""}
                      placeholder="Add phone number"
                      onBlur={(e) => {
                        const next = clampText(e.target.value, LIMITS.shortText);
                        if (next !== (v.phone || "")) onUpdatePhone(v.id, next);
                      }}
                      style={{
                        fontFamily: FONT_MONO, fontSize: 11, color: COLORS.inkFaint, background: "none",
                        border: "none", outline: "none", padding: 0, width: 130,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: COLORS.inkSoft, minWidth: 100, textAlign: "right" }}>
              {currency(v.cost)}
            </div>
            {readOnly ? (
              <span
                style={{
                  fontFamily: FONT_BODY, fontSize: 11, fontWeight: 600, padding: "4px 10px",
                  borderRadius: 999, background: tag.bg, color: tag.fg, whiteSpace: "nowrap",
                }}
              >
                {tag.label}
              </span>
            ) : (
              <button
                onClick={() => onCycleStatus(v.id)}
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: tag.bg,
                  color: tag.fg,
                  border: "none",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title="Click to change status"
              >
                {tag.label}
              </button>
            )}
          </div>
        );
      })}

      {!readOnly && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px dashed ${COLORS.line}` }}>
          <Eyebrow>Add a vendor</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendor name" />
            <input style={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category (e.g. Catering)" />
            <input style={inputStyle} value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact email" />
            <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" />
            <input style={inputStyle} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost (₦)" type="number" />
          </div>
          {error && <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, marginTop: 8 }}>{error}</div>}
          <button
            onClick={submit}
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 4,
              border: "none",
              background: COLORS.brass,
              color: COLORS.card,
              fontFamily: FONT_BODY,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <Plus size={14} /> Add vendor
          </button>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Messages ---------------- */

function authorStyle(authorType) {
  const map = {
    planner: { bg: COLORS.paperDeep, fg: COLORS.ink, align: "flex-start", tag: "Studio" },
    client: { bg: COLORS.brassPale, fg: COLORS.brassDeep, align: "flex-end", tag: "Client" },
    vendor: { bg: COLORS.clayPale, fg: COLORS.clayDeep, align: "flex-start", tag: "Vendor" },
  };
  return map[authorType] || map.planner;
}

function MessageBubble({ msg, onOpenImage }) {
  const s = authorStyle(msg.authorType);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: s.align, marginBottom: 14 }}>
      <div
        style={{
          maxWidth: "78%",
          background: s.bg,
          borderRadius: 10,
          padding: msg.imageData ? 8 : "10px 14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, padding: msg.imageData ? "2px 6px 0" : 0 }}>
          <span style={{ fontFamily: FONT_BODY, fontSize: 12, fontWeight: 700, color: s.fg }}>{msg.authorName}</span>
          <span style={{ fontFamily: FONT_BODY, fontSize: 10, fontWeight: 600, color: s.fg, opacity: 0.65, textTransform: "uppercase", letterSpacing: 0.4 }}>
            {s.tag}
          </span>
        </div>
        {msg.imageData && (
          <img
            src={msg.imageData}
            alt="Shared attachment"
            onClick={() => onOpenImage(msg.imageData)}
            style={{ display: "block", width: "100%", maxWidth: 260, borderRadius: 6, cursor: "zoom-in", marginBottom: msg.body ? 6 : 2 }}
          />
        )}
        {msg.body && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.ink, lineHeight: 1.5, padding: msg.imageData ? "0 6px 4px" : 0 }}>
            {msg.body}
          </div>
        )}
      </div>
      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLORS.inkFaint, marginTop: 4 }}>{formatTimestamp(msg.timestamp)}</span>
    </div>
  );
}

/**
 * senderOptions: array of { value, label, authorType } the composer can post as.
 * Studio passes team members + vendors (since vendors don't have their own login in
 * this prototype — see the auth spec for how a real vendor portal would work).
 * Client passes just themselves, so no picker is shown.
 */
function MessageThread({ messages, senderOptions, onSend }) {
  const [senderValue, setSenderValue] = useState(senderOptions[0]?.value || "");
  const [body, setBody] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [imageError, setImageError] = useState("");
  const [processingImage, setProcessingImage] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const endRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  const submit = () => {
    if (!body.trim() && !pendingImage) return;
    const sender = senderOptions.find((s) => s.value === senderValue) || senderOptions[0];
    onSend({
      authorType: sender.authorType,
      authorName: sender.label,
      body: clampText(body, LIMITS.message),
      imageData: pendingImage || undefined,
    });
    setBody("");
    setPendingImage(null);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImageError("Please choose an image file.");
      return;
    }
    if (file.size > LIMITS.maxImageBytes) {
      setImageError("That image is too large (max 15MB) — try a smaller file.");
      return;
    }
    setImageError("");
    setProcessingImage(true);
    try {
      const dataUrl = await resizeImageFile(file);
      setPendingImage(dataUrl);
    } catch (err) {
      setImageError("Couldn't process that image — try a different file.");
    } finally {
      setProcessingImage(false);
    }
  };

  const fieldStyle = {
    fontFamily: FONT_BODY, fontSize: 13, padding: "9px 12px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper,
    color: COLORS.ink, outline: "none",
  };

  return (
    <SectionCard>
      <SectionTitle>Messages</SectionTitle>
      <div style={{ maxHeight: 360, overflowY: "auto", marginBottom: 16, paddingRight: 4 }}>
        {messages.length === 0 && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, marginBottom: 10 }}>
            No messages yet — start the conversation below.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} onOpenImage={setLightbox} />
        ))}
        <div ref={endRef} />
      </div>

      {pendingImage && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, background: COLORS.paper, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 8 }}>
          <img src={pendingImage} alt="Attachment preview" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4 }} />
          <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, flex: 1 }}>Image ready to send</span>
          <button
            onClick={() => setPendingImage(null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: COLORS.inkFaint, cursor: "pointer" }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {imageError && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, marginBottom: 8 }}>{imageError}</div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {senderOptions.length > 1 && (
          <select
            value={senderValue}
            onChange={(e) => setSenderValue(e.target.value)}
            style={{ ...fieldStyle, flexShrink: 0, width: 168 }}
          >
            {senderOptions.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        )}
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={senderOptions.length > 1 ? "Write a message…" : "Write a message to your planning team…"}
          maxLength={LIMITS.message}
          style={{ ...fieldStyle, flex: 1, minWidth: 160 }}
        />
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={processingImage}
          title="Attach a photo"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 38, borderRadius: 4,
            border: `1px solid ${COLORS.line}`, background: COLORS.paper, color: COLORS.inkSoft, cursor: "pointer",
          }}
        >
          <ImagePlus size={16} />
        </button>
        <button
          onClick={submit}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 4,
            border: "none", background: COLORS.ink, color: COLORS.paper,
            fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}
        >
          <Send size={13} /> Send
        </button>
      </div>
      {processingImage && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.inkFaint, marginTop: 6 }}>Processing image…</div>
      )}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(27,46,40,0.85)", zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 24, cursor: "zoom-out",
          }}
        >
          <img src={lightbox} alt="Shared attachment, enlarged" style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: 6 }} />
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Proposal document (print / PDF) ---------------- */

function ProposalDocumentPage({ event, onBack }) {
  const total = event.proposal.items.reduce((s, i) => s + i.qty * i.unitCost, 0);
  const refNumber = `DOS-${event.id.toUpperCase()}-01`;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.paper }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>
      <div className="no-print" style={{ maxWidth: 760, margin: "0 auto", padding: "20px 20px 0", display: "flex", justifyContent: "space-between" }}>
        <button
          onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          <ChevronLeft size={15} /> Back to proposal
        </button>
        <button
          onClick={() => window.print()}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 4,
            border: "none", background: COLORS.ink, color: COLORS.paper,
            fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}
        >
          <Printer size={14} /> Print / save as PDF
        </button>
      </div>

      <div
        style={{
          maxWidth: 760, margin: "24px auto 60px", background: COLORS.card,
          border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: "48px 56px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 40, borderBottom: `2px solid ${COLORS.ink}`, paddingBottom: 20 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src="/brand/bit-icon.png" alt="BiT" style={{ width: 24, height: 24, borderRadius: "50%" }} />
              <div style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: 26, color: COLORS.ink }}>BiT Affairs</div>
            </div>
            <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>Full-service event production</div>
          </div>
          <div style={{ textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: COLORS.inkSoft }}>
            <div>Proposal No. {refNumber}</div>
            <div>Date: {today()}</div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 32, flexWrap: "wrap", gap: 16 }}>
          <div>
            <Eyebrow>Prepared for</Eyebrow>
            <div style={{ fontFamily: FONT_BODY, fontSize: 15, fontWeight: 600, color: COLORS.ink, marginTop: 4 }}>{event.clientName}</div>
          </div>
          <div>
            <Eyebrow>Event</Eyebrow>
            <div style={{ fontFamily: FONT_BODY, fontSize: 15, fontWeight: 600, color: COLORS.ink, marginTop: 4 }}>{event.name}</div>
            <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 2 }}>{event.date} · {event.venue}</div>
          </div>
        </div>

        <Eyebrow>Scope of services</Eyebrow>
        <div style={{ marginTop: 10, marginBottom: 24 }}>
          {event.proposal.items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex", justifyContent: "space-between", padding: "14px 0",
                borderBottom: `1px solid ${COLORS.line}`, fontFamily: FONT_BODY, fontSize: 14, color: COLORS.ink,
              }}
            >
              <span>{item.label}</span>
              <span style={{ fontFamily: FONT_MONO, color: COLORS.inkSoft }}>{currency(item.qty * item.unitCost)}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "16px 0 0", fontFamily: FONT_BODY, fontSize: 16, fontWeight: 700, color: COLORS.ink }}>
            <span>Total</span>
            <span style={{ fontFamily: FONT_MONO }}>{currency(total)}</span>
          </div>
        </div>

        <Eyebrow>Payment terms</Eyebrow>
        <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, lineHeight: 1.7, marginTop: 8 }}>
          A 50% deposit is due upon signing to confirm this scope of work. The remaining balance is due
          14 days before the event date. This proposal is valid for 30 days from the date above.
        </p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 48, paddingTop: 24, borderTop: `1px solid ${COLORS.line}` }}>
          <div>
            <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkFaint }}>Agency signature</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontSize: 18, color: COLORS.ink, marginTop: 8 }}>BiT Affairs</div>
          </div>
          <div
            style={{
              width: 72, height: 72, borderRadius: "50%", border: `2.5px solid ${COLORS.brass}`,
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}
          >
            <Stamp size={26} color={COLORS.brassDeep} strokeWidth={1.5} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- New Project ---------------- */

const PROJECT_TYPES = ["Wedding", "Corporate", "Social", "Other"];
const DEFAULT_PHASE_TEMPLATE = [
  { title: "Foundations", tasks: [] },
  { title: "Vendors & design", tasks: [] },
  { title: "Final details", tasks: [] },
];

function NewProjectForm({ onCreate, onBack }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(PROJECT_TYPES[0]);
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [date, setDate] = useState("");
  const [venue, setVenue] = useState("");
  const [budget, setBudget] = useState("");
  const [teamInput, setTeamInput] = useState("");
  const [team, setTeam] = useState([]);
  const [error, setError] = useState("");

  const fieldStyle = {
    width: "100%", fontFamily: FONT_BODY, fontSize: 14, padding: "11px 14px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper,
    color: COLORS.ink, outline: "none",
  };

  const addTeamMember = () => {
    const trimmed = teamInput.trim();
    if (!trimmed) return;
    if (team.includes(trimmed)) return;
    setTeam([...team, trimmed]);
    setTeamInput("");
  };

  const removeTeamMember = (t) => setTeam(team.filter((x) => x !== t));

  const submit = () => {
    if (!name.trim() || !clientName.trim()) {
      setError("Give the project a name and add your client's name.");
      return;
    }
    if (team.length === 0) {
      setError("Assign at least one team member.");
      return;
    }
    if (clientEmail.trim() && !isPlausibleEmail(clientEmail)) {
      setError("That client email doesn't look right — double check it.");
      return;
    }
    setError("");
    const id = `ev-${Date.now()}`;
    const phases = DEFAULT_PHASE_TEMPLATE.map((phase, pi) => ({
      id: `p${pi + 1}`,
      title: phase.title,
      tasks: phase.tasks.map((label, ti) => ({
        id: `t${pi}-${ti}`,
        label,
        done: false,
        assignee: team[0],
      })),
    }));
    onCreate({
      id,
      name: clampText(name, LIMITS.shortText),
      type,
      clientName: clampText(clientName, LIMITS.shortText),
      clientEmail: clampText(clientEmail, LIMITS.shortText),
      date: clampText(date, LIMITS.shortText) || "TBD",
      venue: clampText(venue, LIMITS.shortText) || "TBD",
      status: "Early planning",
      team,
      phases,
      budget: { total: Math.max(0, Number(budget) || 0), items: [] },
      proposal: { items: [], status: "draft", sentAt: null, approvedAt: null },
      approvals: [],
      vendors: [],
      messages: [],
    });
  };

  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "0 20px 60px" }}>
      <button
        onClick={onBack}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
          color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "20px 0 8px",
        }}
      >
        <ChevronLeft size={15} /> All productions
      </button>
      <Eyebrow>New project</Eyebrow>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: "clamp(26px, 4vw, 36px)", color: COLORS.ink, margin: "6px 0 24px" }}>
        Start a production
      </h1>

      <SectionCard>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Project name</label>
          <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chidinma's 30th Birthday" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
          <div>
            <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Type</label>
            <select style={fieldStyle} value={type} onChange={(e) => setType(e.target.value)}>
              {PROJECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Event date</label>
            <input style={fieldStyle} value={date} onChange={(e) => setDate(e.target.value)} placeholder="e.g. Nov 14, 2026" />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
          <div>
            <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Client name</label>
            <input style={fieldStyle} value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client's full name" />
          </div>
          <div>
            <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Client email</label>
            <input style={fieldStyle} value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="client@email.com" />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Venue</label>
          <input style={fieldStyle} value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue name & city" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Estimated budget (₦)</label>
          <input type="number" style={fieldStyle} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 5000000" />
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Assign team</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              style={{ ...fieldStyle, flex: 1 }}
              value={teamInput}
              onChange={(e) => setTeamInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTeamMember())}
              placeholder="Team member name, press enter"
            />
            <button
              onClick={addTeamMember}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 42, borderRadius: 4,
                border: "none", background: COLORS.brass, color: COLORS.ink, cursor: "pointer",
              }}
            >
              <Plus size={18} />
            </button>
          </div>
          {team.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              {team.map((t) => (
                <span
                  key={t}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, background: COLORS.paperDeep,
                    borderRadius: 999, padding: "6px 6px 6px 12px", fontFamily: FONT_BODY, fontSize: 13, color: COLORS.ink,
                  }}
                >
                  {t}
                  <button
                    onClick={() => removeTeamMember(t)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(27,46,40,0.1)",
                      border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", color: COLORS.ink,
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, marginBottom: 14 }}>{error}</div>}

        <button
          onClick={submit}
          style={{
            width: "100%", padding: "12px 18px", borderRadius: 4, border: "none",
            background: COLORS.brass, color: COLORS.ink, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 14, cursor: "pointer",
          }}
        >
          Create project
        </button>
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.inkFaint, marginTop: 10 }}>
          Starts with a standard three-phase checklist you can customize afterward.
        </div>
      </SectionCard>
    </div>
  );
}

/* ---------------- Admin approval queue ---------------- */

function TeamManagement({ onBack, currentPlannerId }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("team");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");

  useEffect(() => {
    fetchTeamMembers().then(setMembers).catch((err) => setError(err?.message || "Couldn't load team members"));
  }, []);

  const invite = async () => {
    if (!isPlausibleEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setError("");
    setSending(true);
    try {
      await invitePlanner(clampText(email, LIMITS.shortText), role);
      setSentTo(email.trim());
      setEmail("");
      const refreshed = await fetchTeamMembers();
      setMembers(refreshed);
    } catch (err) {
      setError(err?.message || "Couldn't send that invite — try again.");
    } finally {
      setSending(false);
    }
  };

  const changeRole = async (plannerId, newRole) => {
    try {
      await updatePlannerRole(plannerId, newRole);
      setMembers((prev) => prev.map((m) => (m.id === plannerId ? { ...m, role: newRole } : m)));
    } catch (err) {
      setError(err?.message || "Couldn't update that role.");
    }
  };

  const remove = async (plannerId) => {
    setError("");
    try {
      await removePlanner(plannerId);
      setMembers((prev) => prev.filter((m) => m.id !== plannerId));
    } catch (err) {
      setError(err?.message || "Couldn't remove that team member.");
    }
  };

  const fieldStyle = {
    fontFamily: FONT_BODY, fontSize: 13, padding: "9px 12px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 20px 60px" }}>
      <button
        onClick={onBack}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
          color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "20px 0 8px",
        }}
      >
        <ChevronLeft size={15} /> Studio
      </button>
      <Eyebrow>Admin</Eyebrow>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: "clamp(28px, 5vw, 38px)", color: COLORS.ink, margin: "6px 0 26px" }}>
        Team
      </h1>

      <SectionCard style={{ marginBottom: 16 }}>
        <SectionTitle>Members</SectionTitle>
        {members === null && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint }}>Loading…</div>
        )}
        {members?.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
              padding: "12px 0", borderBottom: `1px solid ${COLORS.line}`, flexWrap: "wrap",
            }}
          >
            <span style={{ fontFamily: FONT_BODY, fontSize: 14, color: COLORS.ink }}>{m.email}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                onClick={() => changeRole(m.id, m.role === "admin" ? "team" : "admin")}
                style={{
                  fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
                  padding: "4px 10px", borderRadius: 999, border: "none", cursor: "pointer",
                  background: m.role === "admin" ? COLORS.brassPale : COLORS.line,
                  color: m.role === "admin" ? COLORS.brassDeep : COLORS.inkSoft,
                }}
                title="Click to toggle role"
              >
                {m.role === "admin" ? "Admin" : "Team member"}
              </button>
              {m.id !== currentPlannerId && <RemoveMemberControl onRemove={() => remove(m.id)} />}
            </div>
          </div>
        ))}
      </SectionCard>

      <SectionCard>
        <SectionTitle>Add a team member</SectionTitle>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@youragency.com"
            style={{ ...fieldStyle, flex: 1, minWidth: 200 }}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={fieldStyle}>
            <option value="team">Team member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            onClick={invite}
            disabled={sending}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 4,
              border: "none", background: COLORS.ink, color: COLORS.card,
              fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: sending ? "default" : "pointer",
            }}
          >
            <Mail size={13} /> {sending ? "Sending…" : "Invite"}
          </button>
        </div>
        {error && <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, marginTop: 10 }}>{error}</div>}
        {sentTo && !error && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.brassDeep, marginTop: 10 }}>
            Invite sent to {sentTo} — they'll get a sign-in link by email.
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function AdminQueue({ events, onOpenProject, onApproveProposal, onReleaseApproval, onBack }) {
  const pendingProposals = events.filter((ev) => ev.proposal.status === "pending_review");
  const pendingApprovals = events.flatMap((ev) =>
    (ev.approvals || [])
      .filter((a) => a.status === "pending_review")
      .map((a) => ({ ...a, eventId: ev.id, eventName: ev.name }))
  );
  const totalPending = pendingProposals.length + pendingApprovals.length;

  const RowShell = ({ children }) => (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
        padding: "16px 0", borderBottom: `1px solid ${COLORS.line}`,
      }}
    >
      {children}
    </div>
  );

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 20px 60px" }}>
      <button
        onClick={onBack}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
          color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "20px 0 8px",
        }}
      >
        <ChevronLeft size={15} /> Studio
      </button>
      <Eyebrow>Admin</Eyebrow>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: "clamp(28px, 5vw, 38px)", color: COLORS.ink, margin: "6px 0 6px" }}>
        Approvals queue
      </h1>
      <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, margin: "0 0 26px" }}>
        {totalPending === 0 ? "Nothing waiting on you right now." : `${totalPending} item${totalPending === 1 ? "" : "s"} waiting for your review before they reach a client.`}
      </p>

      <SectionCard style={{ marginBottom: 16 }}>
        <SectionTitle>Proposals</SectionTitle>
        {pendingProposals.length === 0 && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint }}>No proposals awaiting review.</div>
        )}
        {pendingProposals.map((ev) => {
          const total = ev.proposal.items.reduce((s, i) => s + i.qty * i.unitCost, 0);
          return (
            <RowShell key={ev.id}>
              <div style={{ minWidth: 200 }}>
                <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.ink }}>{ev.name}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>{currency(total)} · {ev.clientName}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => onOpenProject(ev.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 4,
                    border: `1px solid ${COLORS.line}`, background: "transparent", color: COLORS.inkSoft,
                    fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
                  }}
                >
                  Open project
                </button>
                <button
                  onClick={() => onApproveProposal(ev.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 4,
                    border: "none", background: COLORS.brass, color: COLORS.ink,
                    fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer",
                  }}
                >
                  <Stamp size={13} /> Approve &amp; send
                </button>
              </div>
            </RowShell>
          );
        })}
      </SectionCard>

      <SectionCard>
        <SectionTitle>Client approvals</SectionTitle>
        {pendingApprovals.length === 0 && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint }}>No approval requests awaiting release.</div>
        )}
        {pendingApprovals.map((a) => (
          <RowShell key={`${a.eventId}-${a.id}`}>
            <div style={{ minWidth: 200 }}>
              <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.ink }}>{a.label}</div>
              <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>{a.eventName}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => onOpenProject(a.eventId)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 4,
                  border: `1px solid ${COLORS.line}`, background: "transparent", color: COLORS.inkSoft,
                  fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
                }}
              >
                Open project
              </button>
              <button
                onClick={() => onReleaseApproval(a.eventId, a.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 4,
                  border: "none", background: COLORS.brass, color: COLORS.ink,
                  fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer",
                }}
              >
                <Stamp size={13} /> Release
              </button>
            </div>
          </RowShell>
        ))}
      </SectionCard>
    </div>
  );
}

/* ---------------- Studio: Dashboard ---------------- */

function StudioDashboard({ events, isAdmin, onOpen, onNewProject }) {
  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "44px 20px 60px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 30 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Eyebrow>Studio</Eyebrow>
            <span
              style={{
                fontFamily: FONT_BODY, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
                padding: "2px 8px", borderRadius: 999,
                background: isAdmin ? COLORS.brassPale : COLORS.line,
                color: isAdmin ? COLORS.brassDeep : COLORS.inkSoft,
              }}
            >
              {isAdmin ? "Admin" : "Team member"}
            </span>
          </div>
          <h1
            style={{
              fontFamily: FONT_DISPLAY,
              fontStyle: "italic",
              fontWeight: 500,
              fontSize: "clamp(30px, 5vw, 42px)",
              color: COLORS.ink,
              margin: "6px 0 0",
            }}
          >
            Current productions
          </h1>
        </div>
        <button
          onClick={onNewProject}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 4,
            border: "none", background: COLORS.brass, color: COLORS.ink,
            fontFamily: FONT_BODY, fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          <Plus size={15} /> New project
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {events.length === 0 && (
          <div
            style={{
              border: `1px dashed ${COLORS.line}`, borderRadius: 4, padding: "48px 24px",
              textAlign: "center", color: COLORS.inkSoft, fontFamily: FONT_BODY,
            }}
          >
            <div style={{ fontSize: 15, marginBottom: 4 }}>No productions yet.</div>
            <div style={{ fontSize: 13 }}>Create your first project to get started.</div>
          </div>
        )}
        {events.map((ev) => {
          const pct = progressOf(ev);
          return (
            <div
              key={ev.id}
              onClick={() => onOpen(ev.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                background: COLORS.card,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 4,
                padding: "18px 22px",
                cursor: "pointer",
              }}
            >
              <ProgressRing pct={pct} size={52} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, color: COLORS.brassDeep, textTransform: "uppercase", letterSpacing: 0.6 }}>
                  {ev.type}
                </div>
                <h3
                  style={{
                    fontFamily: FONT_DISPLAY,
                    fontSize: 19,
                    fontWeight: 500,
                    color: COLORS.ink,
                    margin: "2px 0 6px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ev.name}
                </h3>
                <div style={{ display: "flex", gap: 16, fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, flexWrap: "wrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Calendar size={12} /> {ev.date}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}><MapPin size={12} /> {ev.venue}</span>
                </div>
              </div>
              <StatusTag status={ev.status} />
              <ChevronRight size={18} color={COLORS.inkFaint} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Studio: Event detail ---------------- */

function DeleteProjectControl({ onDelete }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, fontWeight: 600 }}>
          Delete this project permanently?
        </span>
        <button
          onClick={onDelete}
          style={{
            padding: "6px 12px", borderRadius: 4, border: "none", background: COLORS.clay, color: COLORS.card,
            fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: "pointer",
          }}
        >
          Yes, delete
        </button>
        <button
          onClick={() => setConfirming(false)}
          style={{
            padding: "6px 12px", borderRadius: 4, border: `1px solid ${COLORS.line}`, background: "transparent",
            color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{
        display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
        color: COLORS.inkFaint, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
      }}
    >
      <X size={13} /> Delete project
    </button>
  );
}

function RemoveMemberControl({ onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (confirming) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.clayDeep, fontWeight: 600 }}>
          Remove from Studio?
        </span>
        <button
          onClick={async () => {
            setRemoving(true);
            await onRemove();
            setRemoving(false);
          }}
          disabled={removing}
          style={{
            padding: "6px 12px", borderRadius: 4, border: "none", background: COLORS.clay, color: COLORS.card,
            fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, cursor: removing ? "default" : "pointer",
          }}
        >
          {removing ? "Removing…" : "Yes, remove"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={removing}
          style={{
            padding: "6px 12px", borderRadius: 4, border: `1px solid ${COLORS.line}`, background: "transparent",
            color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: removing ? "default" : "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Remove from Studio"
      style={{
        display: "flex", alignItems: "center", background: "none", border: "none",
        color: COLORS.inkFaint, cursor: "pointer", padding: 4,
      }}
    >
      <X size={15} />
    </button>
  );
}

function StudioEventDetail({ event, isAdmin, onBack, onToggleTask, onAssignTask, onAddTask, onDeleteTask, onSubmitProposalReview, onSendProposal, onRejectProposal, onResetProposal, onOpenDocument, onAddProposalItem, onUpdateProposalItem, onDeleteProposalItem, onRequestApproval, onReleaseApproval, onAddVendor, onCycleVendorStatus, onUpdateVendorPhone, onSendMessage, onPreviewClient, onDeleteProject, onApproveTaskRequest, onDismissTaskRequest }) {
  const [tab, setTab] = useState("overview");
  const pct = progressOf(event);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "0 20px 60px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <button
          onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "20px 0 8px",
          }}
        >
          <ChevronLeft size={15} /> All productions
        </button>
        {isAdmin && onDeleteProject && <DeleteProjectControl onDelete={onDeleteProject} />}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <Eyebrow>{event.type} · {event.clientName}</Eyebrow>
          <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: "clamp(26px, 4vw, 36px)", color: COLORS.ink, margin: "6px 0 8px" }}>
            {event.name}
          </h1>
          <div style={{ display: "flex", gap: 16, fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, flexWrap: "wrap" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Calendar size={13} /> {event.date}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><MapPin size={13} /> {event.venue}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Users size={13} /> {event.team.join(", ")}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <button
            onClick={onPreviewClient}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 4,
              border: `1px solid ${COLORS.ink}`, background: "transparent", color: COLORS.ink,
              fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            <Eye size={14} /> Preview client portal
          </button>
          <InviteClientByEmail eventId={event.id} />
          <div style={{ borderTop: `1px dashed ${COLORS.line}`, paddingTop: 12, marginTop: 4 }}>
            <GenerateAccessCode eventId={event.id} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 24, borderBottom: `1px solid ${COLORS.line}`, flexWrap: "wrap" }}>
        {[
          ["overview", "Overview", ListChecks],
          ["proposal", "Proposal", FileText],
          ["approvals", "Approvals", Stamp],
          ["vendors", "Vendors", Truck],
          ["messages", "Messages", MessageCircle],
          ["budget", "Budget", Wallet],
        ].map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "10px 4px", marginRight: 20,
              background: "none", border: "none", borderBottom: tab === key ? `2px solid ${COLORS.brass}` : "2px solid transparent",
              color: tab === key ? COLORS.ink : COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer",
            }}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <SectionCard>
          <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 20 }}>
            <ProgressRing pct={pct} />
            <div>
              <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft }}>Overall progress</div>
              <StatusTag status={event.status} />
            </div>
          </div>
          {(event.taskRequests || []).some((r) => r.status === "pending") && (
            <TaskRequestsPanel
              requests={event.taskRequests}
              phases={event.phases}
              isAdmin={isAdmin}
              onApprove={onApproveTaskRequest}
              onDismiss={onDismissTaskRequest}
            />
          )}
          <SectionTitle>Timeline & tasks</SectionTitle>
          <PhaseChecklist
            phases={event.phases}
            editable
            isAdmin={isAdmin}
            onToggleTask={onToggleTask}
            team={event.team}
            teamMembers={event.teamMembers}
            onAssign={onAssignTask}
            onAddTask={onAddTask}
            onDeleteTask={onDeleteTask}
          />
        </SectionCard>
      )}
      {tab === "proposal" && (
        <ProposalView
          proposal={event.proposal}
          editable
          isAdmin={isAdmin}
          onSubmitReview={onSubmitProposalReview}
          onSend={onSendProposal}
          onReject={onRejectProposal}
          onReset={onResetProposal}
          onOpenDocument={onOpenDocument}
          onAddItem={onAddProposalItem}
          onUpdateItem={onUpdateProposalItem}
          onDeleteItem={onDeleteProposalItem}
        />
      )}
      {tab === "approvals" && (
        <ApprovalsList approvals={event.approvals} editable isAdmin={isAdmin} onRequest={onRequestApproval} onRelease={onReleaseApproval} />
      )}
      {tab === "vendors" && (
        <VendorsView vendors={event.vendors || []} onAddVendor={onAddVendor} onCycleStatus={onCycleVendorStatus} onUpdatePhone={onUpdateVendorPhone} />
      )}
      {tab === "messages" && (
        <MessageThread
          messages={event.messages || []}
          onSend={onSendMessage}
          senderOptions={[
            ...event.team.map((t) => ({ value: `planner:${t}`, label: t.split(" (")[0], authorType: "planner" })),
            ...(event.vendors || []).map((v) => ({ value: `vendor:${v.id}`, label: v.name, authorType: "vendor" })),
          ]}
        />
      )}
      {tab === "budget" && <BudgetView budget={event.budget} vendors={event.vendors} />}
    </div>
  );
}

/* ---------------- Client Portal ---------------- */

function ClientPortal({ event, onToggleTask, onApproveProposal, onDisapproveProposal, onApproveMilestone, onDisapproveMilestone, onSendMessage, onRequestTask, previewMode = false }) {
  const pct = progressOf(event);
  // Anything still awaiting internal admin review should look identical to
  // "draft" from the client's point of view — they should never see, or need
  // to know about, work that hasn't been approved for release yet.
  const clientProposal = event.proposal.status === "pending_review"
    ? { ...event.proposal, status: "draft" }
    : event.proposal;
  const clientApprovals = (event.approvals || []).filter((a) => a.status !== "pending_review");

  // In preview mode these props arrive as undefined (see the root App
  // component) — the invited client is the only session RLS actually lets
  // approve/disapprove/message/request here, so this is belt-and-suspenders
  // against a crash, not the real security boundary.
  const noop = () => {};

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px 60px" }}>
      {previewMode && (
        <div
          style={{
            marginTop: 16, padding: "10px 14px", borderRadius: 6, background: COLORS.paperDeep,
            border: `1px solid ${COLORS.line}`, display: "flex", alignItems: "center", gap: 8,
            fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft,
          }}
        >
          <Eye size={13} /> Previewing as the client — only the client can actually approve, disapprove, message, or request a task here.
        </div>
      )}
      <div style={{ padding: "40px 0 28px", textAlign: "center" }}>
        <Eyebrow>{event.type} · {event.date}</Eyebrow>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: "clamp(30px, 6vw, 44px)", color: COLORS.ink, margin: "8px 0 10px" }}>
          {event.name}
        </h1>
        <div style={{ display: "flex", justifyContent: "center", gap: 16, fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><MapPin size={13} /> {event.venue}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 22 }}>
          <ProgressRing pct={pct} size={80} />
        </div>
        <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, marginTop: 8 }}>
          Your event is coming together
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <SectionCard>
          <SectionTitle>Planning timeline</SectionTitle>
          <PhaseChecklist phases={event.phases} editable={false} />
          {!previewMode && onRequestTask && <TaskRequestForm requests={event.taskRequests} onRequest={onRequestTask} />}
        </SectionCard>

        <ProposalView proposal={clientProposal} editable={false} onApprove={onApproveProposal || noop} onDisapprove={onDisapproveProposal || noop} />

        <ApprovalsList approvals={clientApprovals} editable={false} onApprove={onApproveMilestone || noop} onDisapprove={onDisapproveMilestone || noop} />

        <VendorsView vendors={event.vendors || []} readOnly />

        <BudgetView budget={event.budget} vendors={event.vendors} />

        <MessageThread
          messages={event.messages || []}
          onSend={onSendMessage || noop}
          senderOptions={[{ value: "client", label: event.clientName, authorType: "client" }]}
        />
      </div>
    </div>
  );
}

/* ---------------- Client task requests ---------------- */

function TaskRequestForm({ requests, onRequest }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  const submit = () => {
    if (!label.trim()) return;
    onRequest(clampText(label, LIMITS.shortText), clampText(description, LIMITS.longText));
    setLabel("");
    setDescription("");
  };

  const statusLabel = { pending: "Awaiting review", approved: "Added to checklist", dismissed: "Not added" };

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px dashed ${COLORS.line}` }}>
      <Eyebrow>Request a task</Eyebrow>
      <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkFaint, marginTop: 4, marginBottom: 10 }}>
        Something missing from the plan? Ask your planner to add it.
      </div>

      {(requests || []).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {requests.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                padding: "8px 0", borderBottom: `1px solid ${COLORS.line}`, flexWrap: "wrap",
              }}
            >
              <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.ink }}>{r.label}</span>
              <StatusTag status={statusLabel[r.status] || r.status} />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What would you like added?"
          style={{
            fontFamily: FONT_BODY, fontSize: 13, padding: "9px 12px",
            border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
          }}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Any detail that would help (optional)"
          style={{
            fontFamily: FONT_BODY, fontSize: 13, padding: "9px 12px",
            border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
          }}
        />
        <button
          onClick={submit}
          style={{
            alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
            borderRadius: 4, border: "none", background: COLORS.brass, color: COLORS.ink,
            fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}
        >
          <Plus size={14} /> Request task
        </button>
      </div>
    </div>
  );
}

/* ---------------- Client invite ---------------- */

function InviteClientByEmail({ eventId }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    if (!isPlausibleEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setError("");
    setSending(true);
    try {
      await sbInviteClient(eventId, clampText(email, LIMITS.shortText));
      setSentTo(email.trim());
      setEmail("");
    } catch (err) {
      setError(err?.message || "Couldn't send that invite — try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ maxWidth: 340 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="client@email.com"
          style={{
            flex: 1, fontFamily: FONT_BODY, fontSize: 13, padding: "9px 12px",
            border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={sending}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 4,
            border: "none", background: COLORS.ink, color: COLORS.paper,
            fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: sending ? "default" : "pointer", whiteSpace: "nowrap",
          }}
        >
          <Mail size={13} /> {sending ? "Sending…" : "Invite"}
        </button>
      </div>
      {error && <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.clayDeep, marginTop: 8 }}>{error}</div>}
      {sentTo && !error && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.brassDeep, marginTop: 8 }}>
          Invite sent to {sentTo} — they'll get a real sign-in link by email.
        </div>
      )}
    </div>
  );
}

function GenerateAccessCode({ eventId }) {
  const [code, setCode] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    setGenerating(true);
    setError("");
    try {
      const newCode = await generateClientCode(eventId);
      setCode(newCode);
    } catch (err) {
      setError(err?.message || "Couldn't generate a code — try again.");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // clipboard may be blocked — code is still shown on screen to copy manually
    }
  };

  return (
    <div style={{ maxWidth: 340 }}>
      {code ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1, fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: 3,
              color: COLORS.ink, background: COLORS.paperDeep, borderRadius: 4, padding: "10px 14px", textAlign: "center",
            }}
          >
            {code}
          </div>
          <button
            onClick={copy}
            style={{
              padding: "10px 14px", borderRadius: 4, border: `1px solid ${COLORS.line}`, background: COLORS.card,
              color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      ) : (
        <button
          onClick={generate}
          disabled={generating}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 4,
            border: `1px solid ${COLORS.line}`, background: COLORS.card, color: COLORS.ink,
            fontFamily: FONT_BODY, fontWeight: 600, fontSize: 13, cursor: generating ? "default" : "pointer",
          }}
        >
          <Stamp size={13} /> {generating ? "Generating…" : "Generate access code"}
        </button>
      )}
      {error && <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.clayDeep, marginTop: 8 }}>{error}</div>}
      {code && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.inkFaint, marginTop: 8 }}>
          Give this code to your client — no email needed. Valid 30 days. Generating a new code replaces this one.
        </div>
      )}
    </div>
  );
}

/* ---------------- Auth gate: Welcome, planner login, client invite ---------------- */

function ConfigurationRequired() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: COLORS.paper, color: COLORS.ink }}>
      <style>{FONT_IMPORT}</style>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
          <img src="/brand/bit-icon.png" alt="BiT" style={{ width: 48, height: 48, borderRadius: "50%" }} />
        </div>
        <SectionCard>
          <SectionTitle>Backend not configured</SectionTitle>
          <p style={{ fontFamily: FONT_BODY, fontSize: 14, color: COLORS.inkSoft, lineHeight: 1.6, margin: "0 0 14px" }}>
            This app requires a connected Supabase project to run — there's no local demo fallback.
            Copy <code style={{ fontFamily: FONT_MONO, background: COLORS.paperDeep, padding: "1px 5px", borderRadius: 3 }}>.env.example</code> to{" "}
            <code style={{ fontFamily: FONT_MONO, background: COLORS.paperDeep, padding: "1px 5px", borderRadius: 3 }}>.env</code>, fill in your project's URL and anon key, then rebuild.
          </p>
          <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkFaint, margin: 0 }}>
            Full setup steps are in <code style={{ fontFamily: FONT_MONO, background: COLORS.paperDeep, padding: "1px 5px", borderRadius: 3 }}>README.md</code>.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}

function AuthShell({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <img
            src="/brand/bit-wordmark.jpg"
            alt="BiT — Big Things"
            style={{ width: 168, borderRadius: 12, boxShadow: "0 6px 20px rgba(27,46,40,0.18)" }}
          />
        </div>
        {children}
      </div>
    </div>
  );
}

function WelcomeGate({ onChoosePlanner, onChooseClient, onChooseCode }) {
  const cardStyle = {
    display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left",
    background: COLORS.card, border: `1px solid ${COLORS.line}`, borderRadius: 4,
    padding: "18px 20px", cursor: "pointer", marginBottom: 12,
  };
  return (
    <div>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: 26, color: COLORS.ink, textAlign: "center", margin: "0 0 6px" }}>
        Welcome back
      </h1>
      <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, textAlign: "center", margin: "0 0 28px" }}>
        Sign in to continue
      </p>
      <button onClick={onChoosePlanner} style={cardStyle}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: COLORS.brassPale, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Building2 size={18} color={COLORS.brassDeep} />
        </div>
        <div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 700, color: COLORS.ink }}>I'm on the planning team</div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>Sign in with your agency account</div>
        </div>
      </button>
      <button onClick={onChooseClient} style={cardStyle}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: COLORS.clayPale, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Mail size={18} color={COLORS.clayDeep} />
        </div>
        <div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 700, color: COLORS.ink }}>I have an invite link</div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>View your event as a client</div>
        </div>
      </button>
      <button onClick={onChooseCode} style={cardStyle}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: COLORS.paperDeep, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Stamp size={18} color={COLORS.inkSoft} />
        </div>
        <div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 700, color: COLORS.ink }}>I have an access code</div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkSoft, marginTop: 2 }}>No email needed</div>
        </div>
      </button>
    </div>
  );
}

function CodeLogin({ onSuccess, onBack }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!code.trim()) {
      setError("Enter the code your planner gave you.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const eventId = await redeemClientCode(code);
      onSuccess(eventId);
    } catch (err) {
      setError(err?.message?.includes("Invalid or expired") ? "That code isn't valid or has expired — check with your planner." : (err?.message || "Something went wrong — try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
        <ChevronLeft size={15} /> Back
      </button>
      <SectionCard>
        <Eyebrow>Client access</Eyebrow>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: 20, color: COLORS.ink, margin: "6px 0 6px" }}>
          Enter your access code
        </h2>
        <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, margin: "0 0 18px" }}>
          Your planner will have given you an 8-character code — no email required.
        </p>
        <div style={{ marginBottom: 14 }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="XXXXXXXX"
            maxLength={8}
            style={{
              width: "100%", fontFamily: FONT_MONO, fontSize: 20, fontWeight: 700, letterSpacing: 3, textAlign: "center",
              padding: "14px", border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
            }}
          />
        </div>
        {error && <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, marginBottom: 14 }}>{error}</div>}
        <button
          onClick={submit}
          disabled={submitting}
          style={{
            width: "100%", padding: "12px 18px", borderRadius: 4, border: "none",
            background: COLORS.brass, color: COLORS.card, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 14,
            cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Checking…" : "Continue"}
        </button>
      </SectionCard>
    </div>
  );
}

function PlannerLoginForm({ onSubmit, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const inputStyle = {
    width: "100%", fontFamily: FONT_BODY, fontSize: 14, padding: "11px 14px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper,
    color: COLORS.ink, outline: "none",
  };

  const submit = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password to continue.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setError(err?.message || "Couldn't sign in — check your details and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
        <ChevronLeft size={15} /> Back
      </button>
      <SectionCard>
        <SectionTitle>Studio sign in</SectionTitle>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Email</label>
          <input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com" onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: "block", fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.brassDeep, marginBottom: 6 }}>Password</label>
          <input type="password" style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, marginBottom: 14 }}>{error}</div>}
        <button
          onClick={submit}
          disabled={loading}
          style={{
            width: "100%", padding: "12px 18px", borderRadius: 4, border: "none",
            background: COLORS.ink, color: COLORS.paper, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 14,
            cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: COLORS.inkFaint, marginTop: 12, textAlign: "center" }}>
          Signing in against your connected Supabase project.
        </div>
      </SectionCard>
    </div>
  );
}

function ClientInviteLanding({ onBack }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const fieldStyle = {
    width: "100%", fontFamily: FONT_BODY, fontSize: 14, padding: "11px 14px",
    border: `1px solid ${COLORS.line}`, borderRadius: 4, background: COLORS.paper, color: COLORS.ink, outline: "none",
  };

  const sendLink = async () => {
    if (!isPlausibleEmail(email)) {
      setError("Enter the email address your planner invited you with.");
      return;
    }
    setError("");
    setSending(true);
    try {
      await requestClientMagicLink(clampText(email, LIMITS.shortText));
      setSent(true);
    } catch (err) {
      setError(err?.message || "Couldn't send that link — try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: COLORS.inkSoft, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
        <ChevronLeft size={15} /> Back
      </button>
      <SectionCard>
        <Eyebrow>Client access</Eyebrow>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 500, fontSize: 20, color: COLORS.ink, margin: "6px 0 6px" }}>
          {sent ? "Check your email" : "Get your access link"}
        </h2>
        {sent ? (
          <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, margin: 0 }}>
            If <strong style={{ color: COLORS.ink }}>{email}</strong> has been invited to an event, a sign-in link is on its way. Open it on this device to continue — this tab will pick it up automatically.
          </p>
        ) : (
          <>
            <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.inkSoft, margin: "0 0 18px" }}>
              Enter the email address your planner used to invite you. We'll send a one-time sign-in link — no password needed.
            </p>
            <div style={{ marginBottom: 14 }}>
              <input
                style={fieldStyle}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                onKeyDown={(e) => e.key === "Enter" && sendLink()}
              />
            </div>
            {error && <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: COLORS.clayDeep, marginBottom: 14 }}>{error}</div>}
            <button
              onClick={sendLink}
              disabled={sending}
              style={{
                width: "100%", padding: "12px 18px", borderRadius: 4, border: "none",
                background: COLORS.brass, color: COLORS.ink, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 14,
                cursor: sending ? "default" : "pointer", opacity: sending ? 0.7 : 1,
              }}
            >
              {sending ? "Sending…" : "Send my access link"}
            </button>
          </>
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Top Nav ---------------- */

function TopNav({ role, inEvent, onBackToDashboard, onSignOut, isAdmin, isPreview, pendingCount, onOpenQueue, onOpenTeam }) {
  return (
    <div
      style={{
        position: "sticky", top: 0, zIndex: 10,
        background: "rgba(239,237,228,0.92)", backdropFilter: "blur(8px)",
        borderBottom: `1px solid ${COLORS.line}`,
      }}
    >
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          onClick={role === "client" ? undefined : onBackToDashboard}
          style={{ display: "flex", alignItems: "center", gap: 9, cursor: role === "client" ? "default" : "pointer" }}
        >
          <img src="/brand/bit-icon.png" alt="BiT" style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0 }} />
          <span style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontSize: 19, color: COLORS.ink, fontWeight: 500 }}>
            Bi<span style={{ fontWeight: 400 }}>T</span> Affairs
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {role === "client" && (
          <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.inkFaint, display: "flex", alignItems: "center", gap: 6 }}>
            {isPreview ? <><Eye size={13} /> Previewing as client</> : <><Mail size={13} /> Client view</>}
          </span>
        )}
        {inEvent && (
          <button
            onClick={onBackToDashboard}
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
              color: COLORS.inkSoft, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}
          >
            Back to studio
          </button>
        )}
        {isAdmin && !inEvent && (
          <button
            onClick={onOpenTeam}
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "none",
              border: `1px solid ${COLORS.line}`, borderRadius: 999, padding: "6px 12px",
              color: COLORS.ink, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}
          >
            <Users size={13} /> Team
          </button>
        )}
        {isAdmin && !inEvent && (
          <button
            onClick={onOpenQueue}
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "none",
              border: `1px solid ${COLORS.line}`, borderRadius: 999, padding: "6px 12px",
              color: COLORS.ink, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}
          >
            <Stamp size={13} /> Approvals queue
            {pendingCount > 0 && (
              <span
                style={{
                  background: COLORS.clay, color: COLORS.card, fontSize: 10, fontWeight: 700,
                  borderRadius: 999, minWidth: 16, height: 16, display: "flex", alignItems: "center",
                  justifyContent: "center", padding: "0 4px",
                }}
              >
                {pendingCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={onSignOut}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: COLORS.inkFaint, fontFamily: FONT_BODY, fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}
        >
          Sign out
        </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Live notifications ---------------- */

function NotificationToasts({ notifications, onDismiss }) {
  if (notifications.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed", bottom: 20, right: 20, zIndex: 1000,
        display: "flex", flexDirection: "column", gap: 8, maxWidth: 320,
      }}
    >
      {notifications.map((n) => (
        <div
          key={n.id}
          style={{
            display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px",
            background: COLORS.ink, color: COLORS.paper, borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)", fontFamily: FONT_BODY, fontSize: 13,
          }}
        >
          <span style={{ flex: 1, lineHeight: 1.4 }}>{n.text}</span>
          <button
            onClick={() => onDismiss(n.id)}
            style={{ background: "none", border: "none", color: COLORS.paperDeep, cursor: "pointer", padding: 0, flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Root App ---------------- */

export default function BitAffairs() {
  const [events, setEvents] = useState([]);
  const [role, setRole] = useState("studio");
  const [openEventId, setOpenEventId] = useState(null);
  const [clientEventId, setClientEventId] = useState(null);
  const [docEventId, setDocEventId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState(null);
  const [gateStep, setGateStep] = useState("welcome");
  const [creatingProject, setCreatingProject] = useState(false);
  const [viewingQueue, setViewingQueue] = useState(false);
  const [viewingTeam, setViewingTeam] = useState(false);
  const [notifications, setNotifications] = useState([]);

  // Refs so the long-lived realtime subscription below always reads the
  // *current* open event / event list without needing to tear down and
  // resubscribe every time they change.
  const openEventIdRef = useRef(openEventId);
  useEffect(() => { openEventIdRef.current = openEventId; }, [openEventId]);
  const clientEventIdRef = useRef(clientEventId);
  useEffect(() => { clientEventIdRef.current = clientEventId; }, [clientEventId]);
  const eventsRef = useRef(events);
  useEffect(() => { eventsRef.current = events; }, [events]);

  // Pulls the full event list (already RLS-scoped to the caller — a planner
  // gets their org's events, a client gets only their one event) and
  // assembles each into the nested shape the rest of the app expects.
  async function loadEventsFromSupabase() {
    const rows = await sbFetchEvents();
    const assembled = await Promise.all(
      rows.map(async (row) => {
        const detail = await fetchEventDetail(row.id);
        return assembleEventFromSupabase(row, detail);
      })
    );
    setEvents(assembled);
  }

  // Re-fetches just one event after a mutation. Simpler and safer than hand
  // -rolling optimistic local updates for a dozen different mutation shapes —
  // the tradeoff is a network round-trip per action, which is the right
  // tradeoff for correctness in a first real-backend pass.
  async function refreshEvent(eventId) {
    const { data: eventRow, error } = await supabase.from("events").select("*").eq("id", eventId).single();
    if (error) throw error;
    const detail = await fetchEventDetail(eventId);
    const assembled = assembleEventFromSupabase(eventRow, detail);
    setEvents((prev) => prev.map((e) => (e.id === eventId ? assembled : e)));
  }

  // Called on load, and whenever Supabase Auth's session changes (covers the
  // magic-link redirect completing after a client clicks their invite email).
  async function restoreSessionFromAuth() {
    const plannerProfile = await getCurrentPlanner().catch(() => null);
    if (plannerProfile) {
      setSession({
        type: "planner",
        orgRole: plannerProfile.role,
        organizationId: plannerProfile.organization_id,
        plannerId: plannerProfile.id,
      });
      setRole("studio");
      await loadEventsFromSupabase();
      return true;
    }
    const eventIdForClient = await getCurrentClientEvent().catch(() => null);
    if (eventIdForClient) {
      setSession({ type: "client", eventId: eventIdForClient });
      setClientEventId(eventIdForClient);
      setRole("client");
      await loadEventsFromSupabase();
      return true;
    }
    return false;
  }

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoaded(true);
      return;
    }
    (async () => {
      try {
        const { data: { session: authSession } } = await supabase.auth.getSession();
        if (authSession) await restoreSessionFromAuth();
      } catch (e) {
        console.error("Failed to restore Supabase session", e);
      } finally {
        setLoaded(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, authSession) => {
      if (authSession) {
        await restoreSessionFromAuth();
      } else {
        setSession(null);
        setEvents([]);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Live updates + notifications — see 0015_realtime.sql. One subscription
  // covers messages, proposals, approvals, and task_requests; Realtime's
  // own RLS enforcement means each connected user only ever receives rows
  // their normal SELECT policies already allow, so nothing extra needs
  // filtering client-side. Whichever event is currently open gets a silent
  // re-fetch (no page reload); messages/proposals/approvals additionally
  // surface as a toast for whoever's connected, studio or client.
  useEffect(() => {
    if (!session || !supabaseConfigured) return;

    // Defensive: a blocked or failed realtime connection (misconfigured CSP,
    // flaky network, Supabase project paused, etc.) should degrade to "no
    // live updates" — not take down the rest of the app. A CSP-blocked
    // WebSocket in particular throws synchronously per spec, so this can't
    // just rely on a .catch() on a promise; it needs an actual try/catch.
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeToActivity((table, payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      const affectedEventId = row?.event_id;
      if (!affectedEventId) return;

      if (affectedEventId === openEventIdRef.current || affectedEventId === clientEventIdRef.current) {
        refreshEvent(affectedEventId).catch((err) => console.error("Failed to live-refresh event", err));
      }

      // Task requests get the live re-fetch above (keeps the admin queue
      // current) but no toast — the ask was notifications for messages,
      // proposals, and approvals specifically.
      if (table === "task_requests") return;

      const eventName = eventsRef.current.find((e) => e.id === affectedEventId)?.name || "an event";
      let text = null;
      if (table === "messages" && payload.eventType === "INSERT") {
        text = `${row.author_name || "Someone"} sent a message on ${eventName}`;
      } else if (table === "proposals" && payload.eventType === "UPDATE") {
        const byStatus = {
          sent: `${eventName}: proposal sent to the client`,
          approved: `${eventName}: client approved the proposal`,
          disapproved: `${eventName}: client requested changes to the proposal`,
          pending_review: `${eventName}: proposal submitted for review`,
        };
        text = byStatus[row.status] || null;
      } else if (table === "approvals") {
        if (payload.eventType === "INSERT" && row.status === "pending") {
          text = `${eventName}: a new approval was sent to the client`;
        } else if (payload.eventType === "UPDATE") {
          const byStatus = {
            pending: `${eventName}: an approval was released to the client`,
            approved: `${eventName}: client approved a milestone`,
            disapproved: `${eventName}: client requested changes on a milestone`,
          };
          text = byStatus[row.status] || null;
        }
      }

      if (text) {
        const id = `${Date.now()}-${Math.random()}`;
        setNotifications((prev) => [...prev.slice(-19), { id, text }]);
        setTimeout(() => setNotifications((prev) => prev.filter((n) => n.id !== id)), 7000);
      }
      });
    } catch (err) {
      console.error("Failed to open realtime subscription — live updates disabled for this session", err);
    }

    return unsubscribe;
  }, [session, supabaseConfigured]);

  const handleToggleTask = async (eventId, phaseId, taskId) => {
    const task = events.find((e) => e.id === eventId)?.phases.find((p) => p.id === phaseId)?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    try {
      await sbToggleTask(taskId, !task.done);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to toggle task", err);
    }
  };

  const handleSubmitProposalForReview = async (eventId) => {
    try {
      await sbSubmitProposalForReview(eventId);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to submit proposal for review", err);
    }
  };

  const handleSendProposal = async (eventId) => {
    try {
      await sbApproveAndSendProposal(eventId); // trigger rejects this server-side unless caller is admin
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to send proposal", err);
    }
  };

  const handleRejectProposal = async (eventId) => {
    try {
      await sbRejectProposalToDraft(eventId);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to send proposal back to draft", err);
    }
  };

  const handleApproveProposal = async (eventId) => {
    try {
      await sbClientApproveProposal(eventId); // trigger rejects this server-side unless caller is the invited client
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to approve proposal", err);
    }
  };

  const handleDisapproveProposal = async (eventId) => {
    try {
      await sbClientDisapproveProposal(eventId); // trigger rejects this server-side unless caller is the invited client
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to disapprove proposal", err);
    }
  };

  const handleRequestApproval = async (eventId, label, description) => {
    try {
      // The DB trigger independently forces status to pending_review unless
      // the caller is really an admin — nothing client-side to gate here.
      await sbRequestApproval(eventId, label, description || "Awaiting your review");
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to request approval", err);
    }
  };

  const handleReleaseApproval = async (eventId, approvalId) => {
    try {
      await sbReleaseApprovalToClient(approvalId); // trigger rejects this server-side unless caller is admin
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to release approval", err);
    }
  };

  const handleApproveMilestone = async (eventId, approvalId) => {
    try {
      await sbClientApproveMilestone(approvalId); // trigger rejects this server-side unless caller is the invited client
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to approve milestone", err);
    }
  };

  const handleDisapproveMilestone = async (eventId, approvalId) => {
    try {
      await sbClientDisapproveMilestone(approvalId); // trigger rejects this server-side unless caller is the invited client
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to disapprove milestone", err);
    }
  };

  const handleAssignTask = async (eventId, phaseId, taskId) => {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    const shortNames = event.team.map((t) => t.split(" (")[0]);
    const task = event.phases.find((p) => p.id === phaseId)?.tasks.find((t) => t.id === taskId);
    if (!task || shortNames.length === 0) return;
    const idx = shortNames.indexOf(task.assignee);
    const next = shortNames[(idx + 1) % shortNames.length];
    try {
      await sbAssignTask(taskId, next);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to assign task", err);
    }
  };

  const handleAddTask = async (eventId, phaseId, label, options) => {
    try {
      await sbAddTask(phaseId, label, options);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to add task", err);
    }
  };

  const handleRequestTask = async (eventId, label, description) => {
    try {
      // The DB trigger independently keeps this at 'pending' until an
      // admin resolves it — nothing client-side to gate here.
      await sbRequestTask(eventId, label, description);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to request task", err);
    }
  };

  const handleApproveTaskRequest = async (eventId, requestId, phaseId, label) => {
    try {
      await sbApproveTaskRequest(requestId, phaseId, label); // trigger rejects this server-side unless caller is admin
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to approve task request", err);
    }
  };

  const handleDismissTaskRequest = async (eventId, requestId) => {
    try {
      await sbDismissTaskRequest(requestId); // trigger rejects this server-side unless caller is admin
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to dismiss task request", err);
    }
  };

  const handleDeleteTask = async (eventId, phaseId, taskId) => {
    try {
      await sbDeleteTask(taskId);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to delete task", err);
    }
  };

  const handleDeleteProject = async (eventId) => {
    try {
      await sbDeleteEvent(eventId);
      setOpenEventId(null);
      await loadEventsFromSupabase();
    } catch (err) {
      console.error("Failed to delete project", err);
    }
  };

  const handleAddProposalItem = async (eventId, item) => {
    try {
      await sbAddProposalItem(eventId, item);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to add proposal item", err);
    }
  };

  const handleUpdateProposalItem = async (eventId, itemId, item) => {
    try {
      await sbUpdateProposalItem(itemId, item);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to update proposal item", err);
    }
  };

  const handleDeleteProposalItem = async (eventId, itemId) => {
    try {
      await sbDeleteProposalItem(itemId);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to delete proposal item", err);
    }
  };

  const handleAddVendor = async (eventId, vendor) => {
    try {
      await sbAddVendor(eventId, vendor);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to add vendor", err);
    }
  };

  const handleCycleVendorStatus = async (eventId, vendorId) => {
    const order = ["inquiry", "pending", "confirmed"];
    const current = events.find((e) => e.id === eventId)?.vendors?.find((v) => v.id === vendorId)?.status;
    const next = order[(order.indexOf(current) + 1) % order.length];
    try {
      await sbCycleVendorStatus(vendorId, next);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to update vendor status", err);
    }
  };

  const handleUpdateVendorPhone = async (eventId, vendorId, phone) => {
    try {
      await sbUpdateVendorPhone(vendorId, phone);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to update vendor phone", err);
    }
  };

  const handleSendMessage = async (eventId, message) => {
    try {
      await sbSendMessage(eventId, message.authorType, message.authorName, message.body, message.imageData);
      await refreshEvent(eventId);
    } catch (err) {
      console.error("Failed to send message", err);
    }
  };

  const handleCreateProject = async (newEvent) => {
    try {
      const eventId = await sbCreateEvent({
        organizationId: session?.organizationId,
        plannerId: session?.plannerId,
        name: newEvent.name,
        type: newEvent.type,
        date: newEvent.date,
        venue: newEvent.venue,
        clientName: newEvent.clientName,
        clientEmail: newEvent.clientEmail,
        budgetTotal: newEvent.budget?.total || 0,
        phaseTemplate: newEvent.phases.map((p) => ({ title: p.title, tasks: p.tasks.map((t) => t.label) })),
      });
      await loadEventsFromSupabase();
      setCreatingProject(false);
      setOpenEventId(eventId);
    } catch (err) {
      console.error("Failed to create project", err);
    }
  };

  if (!supabaseConfigured) {
    return <ConfigurationRequired />;
  }

  const docEvent = events.find((e) => e.id === docEventId);
  if (docEvent) {
    return <ProposalDocumentPage event={docEvent} onBack={() => setDocEventId(null)} />;
  }

  if (!session) {
    return (
      <div style={{ minHeight: "100vh", background: COLORS.paper, color: COLORS.ink }}>
        <style>{`${FONT_IMPORT} * { box-sizing: border-box; } input::placeholder { color: ${COLORS.inkFaint}; }`}</style>
        <AuthShell>
          {gateStep === "welcome" && (
            <WelcomeGate
              onChoosePlanner={() => setGateStep("planner")}
              onChooseClient={() => setGateStep("client")}
              onChooseCode={() => setGateStep("code")}
            />
          )}
          {gateStep === "planner" && (
            <PlannerLoginForm
              onBack={() => setGateStep("welcome")}
              onSubmit={async (email, password) => {
                await signInPlanner(email, password);
                const profile = await getCurrentPlanner();
                if (!profile) {
                  throw new Error("Signed in, but this account doesn't have Studio access — it may not have been added yet, or was removed.");
                }
                setSession({
                  type: "planner",
                  orgRole: profile.role,
                  organizationId: profile.organization_id,
                  plannerId: profile.id,
                });
                setRole("studio");
                await loadEventsFromSupabase();
              }}
            />
          )}
          {gateStep === "client" && (
            <ClientInviteLanding onBack={() => setGateStep("welcome")} />
          )}
          {gateStep === "code" && (
            <CodeLogin
              onBack={() => setGateStep("welcome")}
              onSuccess={async (eventId) => {
                setSession({ type: "client", eventId });
                setClientEventId(eventId);
                setRole("client");
                await loadEventsFromSupabase();
              }}
            />
          )}
        </AuthShell>
      </div>
    );
  }

  const openEvent = events.find((e) => e.id === openEventId);
  const clientEvent = events.find((e) => e.id === clientEventId) || events[0];
  const isAdmin = session?.type === "planner" && session.orgRole === "admin";
  // Admin clicked "Preview client portal" — same screen, but this is not
  // the actual invited client, so it should be look-only. The real client's
  // own session (session.type === "client") is the only one that can
  // actually approve, disapprove, message, or request a task here — RLS
  // enforces that server-side regardless, this just keeps the preview UI
  // from showing controls that would silently do nothing if clicked.
  const isPreview = role === "client" && session?.type === "planner";
  const pendingCount =
    events.filter((ev) => ev.proposal.status === "pending_review").length +
    events.reduce((sum, ev) => sum + (ev.approvals || []).filter((a) => a.status === "pending_review").length, 0);

  return (
    <div style={{ minHeight: "100vh", background: COLORS.paper, color: COLORS.ink }}>
      <style>{`
        ${FONT_IMPORT}
        * { box-sizing: border-box; }
        input::placeholder { color: ${COLORS.inkFaint}; }
        @media (prefers-reduced-motion: reduce) {
          * { transition: none !important; animation: none !important; }
        }
        button:focus-visible, input:focus-visible {
          outline: 2px solid ${COLORS.brass};
          outline-offset: 2px;
        }
      `}</style>

      <TopNav
        role={role}
        inEvent={!!openEventId}
        onBackToDashboard={() => {
          setOpenEventId(null);
          setViewingQueue(false);
          setViewingTeam(false);
          setRole("studio");
        }}
        onSignOut={async () => {
          try {
            await sbSignOut();
          } catch (err) {
            console.error("Failed to sign out", err);
          }
          setSession(null);
          setGateStep("welcome");
          setOpenEventId(null);
          setViewingQueue(false);
          setViewingTeam(false);
          setEvents([]);
          setRole("studio");
        }}
        isAdmin={isAdmin}
        isPreview={isPreview}
        pendingCount={pendingCount}
        onOpenQueue={() => {
          setOpenEventId(null);
          setViewingTeam(false);
          setViewingQueue(true);
        }}
        onOpenTeam={() => {
          setOpenEventId(null);
          setViewingQueue(false);
          setViewingTeam(true);
        }}
      />

      {!loaded ? null : role === "studio" ? (
        viewingTeam ? (
          <TeamManagement onBack={() => setViewingTeam(false)} currentPlannerId={session?.plannerId} />
        ) : viewingQueue ? (
          <AdminQueue
            events={events}
            onOpenProject={(eventId) => {
              setViewingQueue(false);
              setOpenEventId(eventId);
            }}
            onApproveProposal={handleSendProposal}
            onReleaseApproval={handleReleaseApproval}
            onBack={() => setViewingQueue(false)}
          />
        ) : openEvent ? (
          <StudioEventDetail
            event={openEvent}
            isAdmin={isAdmin}
            onBack={() => setOpenEventId(null)}
            onToggleTask={(phaseId, taskId) => handleToggleTask(openEvent.id, phaseId, taskId)}
            onAssignTask={(phaseId, taskId) => handleAssignTask(openEvent.id, phaseId, taskId)}
            onAddTask={(phaseId, label, options) => handleAddTask(openEvent.id, phaseId, label, options)}
            onDeleteTask={(phaseId, taskId) => handleDeleteTask(openEvent.id, phaseId, taskId)}
            onSubmitProposalReview={() => handleSubmitProposalForReview(openEvent.id)}
            onSendProposal={() => handleSendProposal(openEvent.id)}
            onRejectProposal={() => handleRejectProposal(openEvent.id)}
            onResetProposal={() => handleRejectProposal(openEvent.id)}
            onOpenDocument={() => setDocEventId(openEvent.id)}
            onAddProposalItem={(item) => handleAddProposalItem(openEvent.id, item)}
            onUpdateProposalItem={(itemId, item) => handleUpdateProposalItem(openEvent.id, itemId, item)}
            onDeleteProposalItem={(itemId) => handleDeleteProposalItem(openEvent.id, itemId)}
            onRequestApproval={(label, desc) => handleRequestApproval(openEvent.id, label, desc)}
            onReleaseApproval={(approvalId) => handleReleaseApproval(openEvent.id, approvalId)}
            onAddVendor={(vendor) => handleAddVendor(openEvent.id, vendor)}
            onCycleVendorStatus={(vendorId) => handleCycleVendorStatus(openEvent.id, vendorId)}
            onUpdateVendorPhone={(vendorId, phone) => handleUpdateVendorPhone(openEvent.id, vendorId, phone)}
            onSendMessage={(message) => handleSendMessage(openEvent.id, message)}
            onPreviewClient={() => {
              setClientEventId(openEvent.id);
              setRole("client");
            }}
            onDeleteProject={() => handleDeleteProject(openEvent.id)}
            onApproveTaskRequest={(requestId, phaseId, label) => handleApproveTaskRequest(openEvent.id, requestId, phaseId, label)}
            onDismissTaskRequest={(requestId) => handleDismissTaskRequest(openEvent.id, requestId)}
          />
        ) : creatingProject ? (
          <NewProjectForm onCreate={handleCreateProject} onBack={() => setCreatingProject(false)} />
        ) : (
          <StudioDashboard events={events} isAdmin={isAdmin} onOpen={setOpenEventId} onNewProject={() => setCreatingProject(true)} />
        )
      ) : (
        <ClientPortal
          event={clientEvent}
          previewMode={isPreview}
          onApproveProposal={isPreview ? undefined : () => handleApproveProposal(clientEvent.id)}
          onDisapproveProposal={isPreview ? undefined : () => handleDisapproveProposal(clientEvent.id)}
          onApproveMilestone={isPreview ? undefined : (approvalId) => handleApproveMilestone(clientEvent.id, approvalId)}
          onDisapproveMilestone={isPreview ? undefined : (approvalId) => handleDisapproveMilestone(clientEvent.id, approvalId)}
          onSendMessage={isPreview ? undefined : (message) => handleSendMessage(clientEvent.id, message)}
          onRequestTask={isPreview ? undefined : (label, description) => handleRequestTask(clientEvent.id, label, description)}
        />
      )}

      <NotificationToasts
        notifications={notifications}
        onDismiss={(id) => setNotifications((prev) => prev.filter((n) => n.id !== id))}
      />
    </div>
  );
}
