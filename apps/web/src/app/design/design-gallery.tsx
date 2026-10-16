"use client";

import { useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  CalendarClock,
  Download,
  FileCheck2,
  FileText,
  Gavel,
  Inbox,
  MailWarning,
  MoreHorizontal,
  PackageCheck,
  Plus,
  Receipt,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { EviantaLogomark, EviantaWordmark } from "@/components/brand/logomark";
import { ChatBubble } from "@/components/patterns/chat-bubble";
import { ConfidenceBadge, type ConfidenceLevel } from "@/components/patterns/confidence-badge";
import { DataTable, type DataTableColumn } from "@/components/patterns/data-table";
import { EmptyState } from "@/components/patterns/empty-state";
import { EvidenceChip } from "@/components/patterns/evidence-chip";
import { MoneyText, NumberText } from "@/components/patterns/number-text";
import { ProvenanceBadge, type ProvenanceKind } from "@/components/patterns/provenance-badge";
import { StatusBadge, statusMeta, type WorkStatus } from "@/components/patterns/status-badge";
import { Timeline, type TimelineItem } from "@/components/patterns/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutoAnimateList } from "@/hooks/use-auto-animate-list";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import { motionDurationMs, motionEasing } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { GalleryRow, GallerySection } from "./gallery-section";

const colorSwatches = [
  { name: "background", className: "bg-background" },
  { name: "muted", className: "bg-muted" },
  { name: "border", className: "bg-border" },
  { name: "muted-foreground", className: "bg-muted-foreground" },
  { name: "foreground", className: "bg-foreground" },
  { name: "primary", className: "bg-primary" },
  { name: "primary-subtle", className: "bg-primary-subtle" },
  { name: "highlight", className: "bg-highlight" },
  { name: "highlight-subtle", className: "bg-highlight-subtle" },
  { name: "success", className: "bg-success" },
  { name: "warning", className: "bg-warning" },
  { name: "danger", className: "bg-danger" },
  { name: "info", className: "bg-info" },
] as const;

const typeScale = [
  { name: "3xl / 30", className: "text-3xl font-semibold" },
  { name: "2xl / 24", className: "text-2xl font-semibold" },
  { name: "xl / 20", className: "text-xl font-semibold" },
  { name: "lg / 18", className: "text-lg font-medium" },
  { name: "base / 16", className: "text-base" },
  { name: "sm / 14", className: "text-sm" },
  { name: "xs / 12", className: "text-xs" },
] as const;

const allStatuses = (Object.keys(statusMeta) as WorkStatus[]).filter(
  (status, index, statuses) =>
    statuses.findIndex((other) => statusMeta[other].label === statusMeta[status].label) === index,
);
const confidenceLevels: ConfidenceLevel[] = ["high", "medium", "low", "unassessed"];
const provenanceKinds: ProvenanceKind[] = ["source", "computed", "specialist", "review", "user"];

interface ReconciliationRow {
  id: string;
  item: string;
  returnAmount: number;
  ledgerAmount: number;
  form26AsAmount: number;
  confidence: ConfidenceLevel;
}

const reconciliationRows: ReconciliationRow[] = [
  {
    id: "interest",
    item: "Interest on fixed deposits",
    returnAmount: 184_500,
    ledgerAmount: 184_500,
    form26AsAmount: 226_500,
    confidence: "high",
  },
  {
    id: "professional",
    item: "Professional fees received",
    returnAmount: 1_250_000,
    ledgerAmount: 1_250_000,
    form26AsAmount: 1_250_000,
    confidence: "high",
  },
  {
    id: "rent",
    item: "Rent received",
    returnAmount: 960_000,
    ledgerAmount: 940_000,
    form26AsAmount: 960_000,
    confidence: "medium",
  },
  {
    id: "turnover",
    item: "Gross turnover",
    returnAmount: 48_200_000,
    ledgerAmount: 48_200_000,
    form26AsAmount: 48_200_000,
    confidence: "unassessed",
  },
];

const reconciliationColumns: DataTableColumn<ReconciliationRow>[] = [
  { id: "item", header: "Item", cell: (row) => row.item, className: "font-medium" },
  {
    id: "return",
    header: "Return",
    numeric: true,
    cell: (row) => <MoneyText amount={row.returnAmount} />,
  },
  {
    id: "ledger",
    header: "Ledger",
    numeric: true,
    cell: (row) => <MoneyText amount={row.ledgerAmount} />,
  },
  {
    id: "form26as",
    header: "Form 26AS",
    numeric: true,
    cell: (row) => <MoneyText amount={row.form26AsAmount} />,
  },
  {
    id: "difference",
    header: "Difference",
    numeric: true,
    cell: (row) => <MoneyText amount={row.returnAmount - row.form26AsAmount} />,
  },
  {
    id: "confidence",
    header: "Evidence",
    cell: (row) => <ConfidenceBadge level={row.confidence} compact />,
  },
];

const chronology: TimelineItem[] = [
  {
    id: "invoice",
    date: "2026-01-12T10:00:00+05:30",
    title: "Invoice INV-0421 raised",
    description: "Supply of precision components to Acme Components Pvt Ltd.",
    icon: Receipt,
    tone: "neutral",
    meta: <EvidenceChip label="invoice_0421.pdf" locator="p. 1" />,
  },
  {
    id: "delivery",
    date: "2026-01-18T10:00:00+05:30",
    title: "Goods delivered and acknowledged",
    icon: PackageCheck,
    tone: "success",
    meta: <EvidenceChip label="delivery_challan.pdf" locator="p. 2" kind="image" />,
  },
  {
    id: "due",
    date: "2026-03-04T10:00:00+05:30",
    title: "Payment due (45 days from acceptance)",
    description: "Section 15 of the MSMED Act limits the agreed period to 45 days.",
    icon: CalendarClock,
    tone: "warning",
  },
  {
    id: "reminder",
    date: "2026-04-02T10:00:00+05:30",
    title: "Payment reminder sent",
    icon: MailWarning,
    tone: "info",
    meta: <EvidenceChip label="reminder_email.eml" locator="msg 1" kind="web" />,
  },
  {
    id: "reference",
    date: "2026-05-20T10:00:00+05:30",
    title: "Reference prepared for the MSE Facilitation Council",
    icon: Gavel,
    tone: "primary",
  },
];

const initialFindings = [
  "Interest income in Form 26AS exceeds the return by 42,000",
  "Rent receipts in the ledger are 20,000 lower than the return",
];

const extraFindings = [
  "TDS credit claimed matches Form 26AS",
  "Professional fee receipts reconcile across all three sources",
  "Turnover figure needs a GST return to confirm",
];

function ColorTokens() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {colorSwatches.map((swatch) => (
        <div key={swatch.name} className="flex flex-col gap-1.5">
          <div className={cn("h-12 rounded-md border", swatch.className)} />
          <span className="font-mono text-xs text-muted-foreground">--{swatch.name}</span>
        </div>
      ))}
    </div>
  );
}

function Typography() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
      <div className="flex flex-col gap-3">
        {typeScale.map((step) => (
          <div key={step.name} className="flex items-baseline gap-4">
            <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
              {step.name}
            </span>
            <span className={step.className}>Evidence leads, chrome stays quiet</span>
          </div>
        ))}
      </div>
      <Card className="w-full lg:w-72">
        <CardHeader>
          <CardDescription>Geist Mono, tabular figures</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-sm">
          <MoneyText amount={48_200_000} />
          <MoneyText amount={1_250_000} />
          <MoneyText amount={42_000} />
          <MoneyText amount={-20_000} />
          <Separator className="my-1" />
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground">Compact</span>
            <MoneyText amount={48_200_000} compact />
          </span>
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground">Count</span>
            <NumberText value={1_843_000} compact />
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

function Buttons() {
  const [loading, setLoading] = useState(false);

  function startLoading() {
    setLoading(true);
    window.setTimeout(() => setLoading(false), 1600);
  }

  return (
    <div className="flex flex-col gap-4">
      <GalleryRow label="Variants">
        <Button>Run case</Button>
        <Button variant="secondary">Save draft</Button>
        <Button variant="outline">Request changes</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="link">View evidence</Button>
        <Button variant="destructive">
          <Trash2 aria-hidden />
          Delete
        </Button>
      </GalleryRow>
      <GalleryRow label="Sizes and states">
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">
          Review case
          <ArrowRight aria-hidden />
        </Button>
        <Button size="icon" variant="outline" aria-label="Download">
          <Download aria-hidden />
        </Button>
        <Button loading={loading} onClick={startLoading}>
          {loading ? "Starting run" : "Start run"}
        </Button>
        <Button disabled>Disabled</Button>
      </GalleryRow>
    </div>
  );
}

function BadgesAndChips() {
  const [selectedChip, setSelectedChip] = useState<string | null>("ledger");
  const [pulseCount, setPulseCount] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <GalleryRow label="Status">
        {allStatuses.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </GalleryRow>
      <GalleryRow label="Evidence confidence">
        {confidenceLevels.map((level) => (
          <ConfidenceBadge key={level} level={level} />
        ))}
        {confidenceLevels.map((level) => (
          <ConfidenceBadge key={`${level}-compact`} level={level} compact />
        ))}
      </GalleryRow>
      <GalleryRow label="Provenance">
        {provenanceKinds.map((kind) => (
          <ProvenanceBadge
            key={kind}
            kind={kind}
            by={kind === "specialist" ? "Reconciliation" : undefined}
          />
        ))}
      </GalleryRow>
      <GalleryRow label="Evidence chips (select one)">
        <EvidenceChip
          label="notice_143(2).pdf"
          locator="para 3"
          selected={selectedChip === "notice"}
          onClick={() => setSelectedChip("notice")}
        />
        <EvidenceChip
          label="ledger_2025-26.xlsx"
          locator="B182:B190"
          kind="spreadsheet"
          selected={selectedChip === "ledger"}
          onClick={() => setSelectedChip("ledger")}
        />
        <EvidenceChip
          label="form26AS.pdf"
          locator="p. 4"
          selected={selectedChip === "form26as"}
          onClick={() => setSelectedChip("form26as")}
        />
        <EvidenceChip
          label="CBDT circular 12/2025"
          kind="web"
          selected={selectedChip === "circular"}
          onClick={() => setSelectedChip("circular")}
        />
      </GalleryRow>
      <GalleryRow label="Evidence jump pulse">
        <EvidenceChip
          key={pulseCount}
          label="bank_interest_certificate.pdf"
          locator="p. 1"
          pulse={pulseCount > 0}
        />
        <Button size="sm" variant="outline" onClick={() => setPulseCount((count) => count + 1)}>
          Jump to source
        </Button>
      </GalleryRow>
      <GalleryRow label="Plain badges">
        <Badge>Primary</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="highlight">Selected</Badge>
        <Badge variant="success">Verified</Badge>
        <Badge variant="warning">Open question</Badge>
        <Badge variant="danger">Missing evidence</Badge>
        <Badge variant="info">Assumption</Badge>
      </GalleryRow>
    </div>
  );
}

function FormFields() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor="case-title">Case title</Label>
        <Input id="case-title" placeholder="ITR notice 143(2), Sharma Textiles" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="case-pan">PAN</Label>
        <Input id="case-pan" aria-invalid defaultValue="ABCDE1234" />
        <p className="text-xs text-danger">PAN must have 10 characters.</p>
      </div>
      <div className="flex flex-col gap-2 md:col-span-2">
        <Label htmlFor="case-description">Description</Label>
        <Textarea
          id="case-description"
          placeholder="Reconcile the notice figures against the ledger and Form 26AS, then prepare a response for review."
        />
      </div>
    </div>
  );
}

function Cards() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card interactive>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle>ITR notice 143(2), Sharma Textiles</CardTitle>
            <StatusBadge status="running" />
          </div>
          <CardDescription>Income-tax notice response</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Mismatch isolated</span>
            <MoneyText amount={42_000} />
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Open questions</span>
            <NumberText value={2} />
          </div>
        </CardContent>
        <CardFooter>
          <ProvenanceBadge kind="specialist" by="5 specialists" />
        </CardFooter>
      </Card>
      <Card interactive>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle>Delayed payment, Acme Components</CardTitle>
            <StatusBadge status="blocked" />
          </div>
          <CardDescription>MSME delayed-payment dispute</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Principal outstanding</span>
            <MoneyText amount={1_875_000} compact />
          </div>
          <p className="text-muted-foreground">Waiting on delivery proof for INV-0421.</p>
        </CardContent>
        <CardFooter>
          <ConfidenceBadge level="low" />
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Loading state</CardDescription>
          <Skeleton className="h-5 w-3/4" />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    </div>
  );
}

function Tables() {
  const totals = reconciliationRows.reduce(
    (sum, row) => ({
      returnAmount: sum.returnAmount + row.returnAmount,
      ledgerAmount: sum.ledgerAmount + row.ledgerAmount,
      form26AsAmount: sum.form26AsAmount + row.form26AsAmount,
    }),
    { returnAmount: 0, ledgerAmount: 0, form26AsAmount: 0 },
  );

  return (
    <DataTable
      columns={reconciliationColumns}
      rows={reconciliationRows}
      getRowId={(row) => row.id}
      selectedRowId="interest"
      caption="Reconciliation of reported income, financial year 2025-26"
      footer={
        <TableRow className="hover:bg-transparent">
          <TableCell>Total</TableCell>
          <TableCell numeric>
            <MoneyText amount={totals.returnAmount} />
          </TableCell>
          <TableCell numeric>
            <MoneyText amount={totals.ledgerAmount} />
          </TableCell>
          <TableCell numeric>
            <MoneyText amount={totals.form26AsAmount} />
          </TableCell>
          <TableCell numeric>
            <MoneyText amount={totals.returnAmount - totals.form26AsAmount} />
          </TableCell>
          <TableCell />
        </TableRow>
      }
    />
  );
}

function EmptyStates() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <EmptyState
        title="No cases yet"
        description="Start a case or open a sample to see the specialists at work."
        action={
          <Button>
            <Plus aria-hidden />
            New case
          </Button>
        }
      />
      <EmptyState
        icon={Inbox}
        title="No documents uploaded"
        description="Upload the notice and supporting documents to begin."
        action={<Button variant="outline">Upload documents</Button>}
      />
    </div>
  );
}

function Chat() {
  return (
    <Card className="max-w-3xl">
      <CardContent className="flex flex-col gap-5 pt-5">
        <ChatBubble role="user" timestamp="2026-10-15T14:05:00+05:30">
          Why does the interest income differ from Form 26AS?
        </ChatBubble>
        <ChatBubble
          role="assistant"
          author="Reconciliation specialist"
          timestamp="2026-10-15T14:05:20+05:30"
          citations={
            <>
              <EvidenceChip label="form26AS.pdf" locator="p. 4" />
              <EvidenceChip label="ledger_2025-26.xlsx" locator="B182:B190" kind="spreadsheet" />
            </>
          }
        >
          Form 26AS reports interest of <MoneyText amount={226_500} /> from two banks, while the
          return and ledger show <MoneyText amount={184_500} />. The difference of{" "}
          <MoneyText amount={42_000} /> matches one fixed deposit that is missing from the ledger.
        </ChatBubble>
      </CardContent>
    </Card>
  );
}

function Overlays() {
  return (
    <div className="flex flex-col gap-4">
      <GalleryRow label="Dialog, sheet, menu, tooltip, toast">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Approve plan</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve the plan</DialogTitle>
              <DialogDescription>
                Approving the plan lets the specialists begin. You will separately review the
                deliverable.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button onClick={() => toast.success("Plan approved")}>Approve plan</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open source</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>form26AS.pdf</SheetTitle>
              <SheetDescription>Page 4, interest from fixed deposits</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-3 px-5">
              <Skeleton className="h-4 w-2/3" />
              <div className="animate-evidence-pulse rounded-md border border-highlight bg-highlight-subtle p-3 text-sm motion-reduce:animate-none">
                Interest on deposits: <MoneyText amount={226_500} />
              </div>
              <Skeleton className="h-4 w-1/2" />
            </div>
            <SheetFooter>
              <ConfidenceBadge level="high" />
            </SheetFooter>
          </SheetContent>
        </Sheet>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Export
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Export deliverable</DropdownMenuLabel>
            <DropdownMenuItem>
              <FileText aria-hidden />
              Word document
              <DropdownMenuShortcut>.docx</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <FileCheck2 aria-hidden />
              Schedules
              <DropdownMenuShortcut>.xlsx</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive>
              <Trash2 aria-hidden />
              Discard draft
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Search evidence">
              <Search aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search evidence</TooltipContent>
        </Tooltip>
        <Button
          variant="secondary"
          onClick={() =>
            toast("Reconciliation completed", {
              description: "3 findings added to the case.",
            })
          }
        >
          Show toast
        </Button>
      </GalleryRow>
      <Tabs defaultValue="findings" className="max-w-2xl">
        <TabsList>
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="deliverable">Deliverable</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>
        <TabsContent value="findings">
          <ScrollArea className="h-40 rounded-md border">
            <ul className="flex flex-col divide-y text-sm">
              {[...initialFindings, ...extraFindings].map((finding) => (
                <li key={finding} className="px-4 py-2.5">
                  {finding}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="deliverable" className="text-sm text-muted-foreground">
          The response draft appears here section by section.
        </TabsContent>
        <TabsContent value="documents" className="text-sm text-muted-foreground">
          Uploaded documents and their processing state appear here.
        </TabsContent>
      </Tabs>
      <div className="h-48 overflow-hidden rounded-lg border">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="30" minSize="20">
            <div className="flex h-full items-center justify-center bg-sidebar text-sm text-muted-foreground">
              Documents
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="40" minSize="25">
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Evidence viewer
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="30" minSize="20">
            <div className="flex h-full items-center justify-center bg-sidebar text-sm text-muted-foreground">
              Findings
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function subscribeToNothing() {
  return () => {};
}

function Motion() {
  const { reduced } = useMotionSafe();
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [findings, setFindings] = useState(initialFindings);
  const listRef = useAutoAnimateList<HTMLUListElement>();

  const nextFinding = extraFindings[findings.length - initialFindings.length];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Motion tokens</CardTitle>
          <CardDescription>
            Shared by Tailwind and Framer Motion.{" "}
            {mounted ? (
              <Badge variant={reduced ? "warning" : "neutral"} className="ml-1 align-middle">
                Reduced motion {reduced ? "on" : "off"}
              </Badge>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {Object.entries(motionDurationMs).map(([name, ms]) => (
            <div key={name} className="flex justify-between">
              <span className="text-muted-foreground">duration-{name}</span>
              <span className="figures">{ms} ms</span>
            </div>
          ))}
          {Object.entries(motionEasing).map(([name, curve]) => (
            <div key={name} className="flex justify-between gap-4">
              <span className="text-muted-foreground">ease-{name}</span>
              <span className="figures truncate">{curve.join(", ")}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Findings streaming in</CardTitle>
          <CardDescription>Live lists reflow with auto-animate.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul ref={listRef} className="flex flex-col gap-2">
            {findings.map((finding) => (
              <li key={finding} className="rounded-md border bg-background px-3 py-2 text-sm">
                {finding}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!nextFinding}
              onClick={() => {
                if (nextFinding) {
                  setFindings((current) => [nextFinding, ...current]);
                }
              }}
            >
              Add finding
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFindings(initialFindings)}>
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ThemePreview({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      className={cn(
        theme,
        "flex flex-col gap-4 rounded-lg border bg-background p-5 text-foreground",
      )}
    >
      <div className="flex items-center justify-between">
        <EviantaWordmark />
        <Badge variant="neutral">{theme === "light" ? "Light" : "Dark"}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status="completed" />
        <StatusBadge status="needs-input" />
        <ConfidenceBadge level="medium" />
        <EvidenceChip label="notice.pdf" locator="para 3" selected />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm">Review</Button>
        <Button size="sm" variant="outline">
          Export
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Total demand <MoneyText amount={4_820_000} className="text-foreground" /> across{" "}
        <NumberText value={3} className="text-foreground" /> assessment years.
      </p>
    </div>
  );
}

export function DesignGallery() {
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <EviantaLogomark className="size-10" title="Evianta logomark" />
          <div>
            <p className="text-xs font-medium text-muted-foreground">Evidence Atlas</p>
            <h1 className="text-2xl font-semibold">Design system</h1>
          </div>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Mineral teal for action, restrained coral for selected evidence, paper-white surfaces and
          graphite type. Every component reads from tokens, so restyling is a token edit.
        </p>
      </header>
      <GallerySection id="themes" title="Both themes" description="Light is the default.">
        <div className="grid gap-4 lg:grid-cols-2">
          <ThemePreview theme="light" />
          <ThemePreview theme="dark" />
        </div>
      </GallerySection>
      <GallerySection id="color" title="Color tokens">
        <ColorTokens />
      </GallerySection>
      <GallerySection id="type" title="Typography">
        <Typography />
      </GallerySection>
      <GallerySection id="buttons" title="Buttons">
        <Buttons />
      </GallerySection>
      <GallerySection
        id="badges"
        title="Badges and chips"
        description="Color is always paired with an icon or text."
      >
        <BadgesAndChips />
      </GallerySection>
      <GallerySection id="forms" title="Form fields">
        <FormFields />
      </GallerySection>
      <GallerySection id="cards" title="Cards and skeletons">
        <Cards />
      </GallerySection>
      <GallerySection
        id="tables"
        title="Data table"
        description="No zebra striping; numbers are right-aligned in mono with Indian grouping."
      >
        <Tables />
      </GallerySection>
      <GallerySection id="empty" title="Empty states">
        <EmptyStates />
      </GallerySection>
      <GallerySection id="timeline" title="Timeline">
        <Card className="max-w-3xl">
          <CardContent className="pt-5">
            <Timeline items={chronology} aria-label="Payment chronology" />
          </CardContent>
        </Card>
      </GallerySection>
      <GallerySection id="chat" title="Chat">
        <Chat />
      </GallerySection>
      <GallerySection id="overlays" title="Overlays, tabs, and panes">
        <Overlays />
      </GallerySection>
      <GallerySection id="motion" title="Motion">
        <Motion />
      </GallerySection>
    </div>
  );
}
