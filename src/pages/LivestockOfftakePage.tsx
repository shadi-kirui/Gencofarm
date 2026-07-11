import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getAuth } from "firebase/auth";
import { db, ref, set, update, remove, push, fetchCollectionByProgrammes, subscribeCollectionByProgramme } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Download, Users, MapPin, Eye, Calendar, Scale, Phone, CreditCard, Edit, Trash2, Weight, Upload, Loader2 } from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { toast, useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { matchesActiveProgramme, PROGRAMME_OPTIONS, resolveAccessibleProgrammes, resolveActiveProgramme } from "@/lib/programme-access";

// Types
interface OfftakeData {
  id: string;
  date: Date | string;
  farmerName: string;
  gender: string;
  idNumber: string;
  liveWeight: number[];
  carcassWeight: number[];
  location: string;
  noSheepGoats: number;
  phoneNumber: string;
  pricePerGoatAndSheep: number[];
  region: string;
  programme: string;
  subcounty: string;
  username: string;
  offtakeUserId: string;
  totalprice: number;
  createdAt: number;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  region: string;
  gender: string;
}

interface Stats {
  totalRegions: number;
  totalAnimals: number;
  totalRevenue: number;
  averageLiveWeight: number;
  averageCarcassWeight: number;
  averageRevenue: number;
  totalFarmers: number;
  totalMaleFarmers: number;
  totalFemaleFarmers: number;
  avgPricePerCarcassKg: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface EditForm {
  date: string;
  farmerName: string;
  gender: string;
  idNumber: string;
  phoneNumber: string;
  region: string;
  location: string;
}

interface WeightEditForm {
  liveWeights: number[];
  carcassWeights: number[];
  prices: number[];
}

// Constants
const PAGE_LIMIT = 15;

// --- HELPERS ---
const cleanNumber = (val: string): number => {
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
};

const parseExcelSerialDate = (value: number): Date | null => {
  if (!Number.isFinite(value) || value < 20000 || value > 80000) return null;
  const excelEpoch = Date.UTC(1899, 11, 30);
  const parsed = new Date(excelEpoch + value * 24 * 60 * 60 * 1000);
  return isNaN(parsed.getTime()) ? null : parsed;
};

const parseDate = (date: any): Date | null => {
  if (!date) return null;
  
  try {
    if (date instanceof Date) {
      return isNaN(date.getTime()) ? null : date;
    }
    
    let trimmed = String(date).trim();
    
    // Normalize ISO strings with timestamps (e.g., from Edit Form) to avoid timezone day-shifting
    const fullIsoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (fullIsoMatch) {
      trimmed = trimmed.substring(0, 10);
    }

    const numericDate = Number(trimmed);
    if (!isNaN(numericDate) && trimmed !== '') {
      const excelDate = parseExcelSerialDate(numericDate);
      if (excelDate) return excelDate;
    }

    const isoDateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateOnly) {
      const [, year, month, day] = isoDateOnly;
      const parsed = new Date(Number(year), Number(month) - 1, Number(day));
      return isNaN(parsed.getTime()) ? null : parsed;
    }

    const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashDate) {
      const [, first, second, year] = slashDate;
      const firstNumber = Number(first);
      const secondNumber = Number(second);
      const parsed = firstNumber > 12
        ? new Date(Number(year), secondNumber - 1, firstNumber)
        : new Date(Number(year), firstNumber - 1, secondNumber);
      return isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch (error) {
    console.error('Error parsing date:', error, date);
  }
  
  return null;
};

const formatDate = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate ? parsedDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }) : 'N/A';
};

const getOfftakeTimestamp = (record: Partial<OfftakeData> | null | undefined): number => {
  if (!record) return 0;
  if (record.createdAt && typeof record.createdAt === 'number' && record.createdAt > 0) {
    return record.createdAt;
  }
  const parsed = parseDate(record.date);
  return parsed ? parsed.getTime() : 0;
};

const sortOfftakeByLatest = (records: OfftakeData[]): OfftakeData[] =>
  [...records].sort((a, b) => getOfftakeTimestamp(b) - getOfftakeTimestamp(a));

const formatDateToLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateInputValue = (value: string): Date | null => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return parseDate(value);
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  return isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateForInput = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate ? formatDateToLocal(parsedDate) : '';
};

const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
  }).format(amount || 0);
};

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  return {
    startDate: formatDateToLocal(startOfMonth),
    endDate: formatDateToLocal(endOfMonth)
  };
};

const calculateAverage = (data: number[]): number => {
  if (!data || data.length === 0) return 0;
  const sum = data.reduce((acc, val) => acc + (Number(val) || 0), 0);
  return sum / data.length;
};

const calculateTotal = (data: number[]): number => {
  if (!data || data.length === 0) return 0;
  return data.reduce((acc, val) => acc + (Number(val) || 0), 0);
};

const isMissingFarmerId = (value: unknown): boolean => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "0" ||
    normalized === "0.0" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "/a" ||
    normalized === "a" ||
    normalized === "null" ||
    normalized === "undefined"
  );
};

const sanitizeGeneratedIdSegment = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

const generateFarmerId = (
  seed: string,
  record?: Partial<Pick<OfftakeData, "farmerName" | "phoneNumber" | "location">> & {
    name?: string;
    phone?: string;
  },
): string => {
  const nameSegment = sanitizeGeneratedIdSegment(record?.farmerName || record?.name || "FARMER") || "FARMER";
  const phoneSegment = sanitizeGeneratedIdSegment(record?.phoneNumber || record?.phone || "");
  const locationSegment = sanitizeGeneratedIdSegment(record?.location || "");
  const seedValue = `${seed}|${nameSegment}|${phoneSegment}|${locationSegment}`;
  let hash = 0;

  for (let index = 0; index < seedValue.length; index += 1) {
    hash = (hash * 31 + seedValue.charCodeAt(index)) >>> 0;
  }

  const suffix = hash.toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `GEN-${nameSegment.slice(0, 4)}-${suffix}`;
};

const resolveFarmerId = (
  value: unknown,
  seed: string,
  record?: Partial<Pick<OfftakeData, "farmerName" | "phoneNumber" | "location">> & {
    name?: string;
    phone?: string;
  },
): string => (isMissingFarmerId(value) ? generateFarmerId(seed, record) : String(value).trim());

const getFarmerPhoneFromRecord = (record: Record<string, unknown>): string => {
  const candidates = [record.phone, record.phoneNumber, record.mobile, record.telephone, record.contact];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return "";
};

const getFarmerGroupingKey = (record: OfftakeData): string => {
  const normalizedId = String(record.idNumber || '').trim().toLowerCase();
  return normalizedId ? `id:${normalizedId}` : `record:${record.id}`;
};

function safeTruncate(value: string | number) {
  let str = String(value).replace(/[^0-9.]/g, "");
  const num = Number(str);
  if (isNaN(num)) return "Invalid Number";
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toLocaleString();
}

// --- SUB-COMPONENTS ---
interface FilterSectionProps {
  localSearchInput: string;
  filters: Filters;
  uniqueRegions: string[];
  uniqueGenders: string[];
  onSearchChange: (value: string) => void;
  onFilterChange: (key: keyof Filters, value: string) => void;
}

const FilterSection = memo(({
  localSearchInput,
  filters,
  uniqueRegions,
  uniqueGenders,
  onSearchChange,
  onFilterChange
}: FilterSectionProps) => (
  <ScrollableFilterBar ariaLabel="Livestock offtake filters" contentClassName="sm:grid-cols-2 lg:grid-cols-5">
    <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="search" className="font-semibold text-gray-700">Search</Label>
      <Input
        id="search"
        placeholder="Search farmers..."
        value={localSearchInput}
        onChange={(e) => onSearchChange(e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>

    <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="region" className="font-semibold text-gray-700">Counties</Label>
      <Select value={filters.region} onValueChange={(value) => onFilterChange("region", value)}>
        <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white">
          <SelectValue placeholder="Select region" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">County</SelectItem>
          {uniqueRegions.slice(0, 20).map(region => (
            <SelectItem key={region} value={region}>{region}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="gender" className="font-semibold text-gray-700">Gender</Label>
      <Select value={filters.gender} onValueChange={(value) => onFilterChange("gender", value)}>
        <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white">
          <SelectValue placeholder="Select gender" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Genders</SelectItem>
          {uniqueGenders.slice(0, 20).map(gender => (
            <SelectItem key={gender} value={gender}>{gender}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="startDate" className="font-semibold text-gray-700">From Date</Label>
      <Input
        id="startDate"
        type="date"
        value={filters.startDate}
        onChange={(e) => onFilterChange("startDate", e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>

    <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="endDate" className="font-semibold text-gray-700">To Date</Label>
      <Input
        id="endDate"
        type="date"
        value={filters.endDate}
        onChange={(e) => onFilterChange("endDate", e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>
  </ScrollableFilterBar>
));
FilterSection.displayName = "FilterSection";

interface StatsCardProps {
  title: string;
  value: string;
  icon: any;
  description?: string;
  subValue?: string;
}

const StatsCard = ({ title, value, icon: Icon, description, subValue }: StatsCardProps) => (
  <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-600"></div>
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
      <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
    </CardHeader>
    <CardContent className="pl-6 pb-4 flex flex-row">
      <div className="mr-2 rounded-full">
        <Icon className="h-8 w-8 text-blue-600" />
      </div>
      <div>
        <div className="text-xl font-bold text-green-500 mb-2">{value}</div>
        {subValue && <div className="text-sm font-medium text-slate-600 mb-2">{subValue}</div>}
        {description && <p className="text-[10px] mt-2 bg-orange-50 px-2 py-1 rounded-md border border-slate-100">{description}</p>}
      </div>
    </CardContent>
  </Card>
);

// --- MAIN PAGE COMPONENT ---
const LivestockOfftakePage = () => {
  const { userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();
  const auth = getAuth();
  
  // State
  const [allOfftake, setAllOfftake] = useState<OfftakeData[]>([]);
  const [filteredOfftake, setFilteredOfftake] = useState<OfftakeData[]>([]);
  const [localSearchInput, setLocalSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<any[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isWeightEditDialogOpen, setIsWeightEditDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isBulkSmsDialogOpen, setIsBulkSmsDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isSingleDeleteDialogOpen, setIsSingleDeleteDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<OfftakeData | null>(null);
  const [editingRecord, setEditingRecord] = useState<OfftakeData | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<OfftakeData | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [bulkSmsMessage, setBulkSmsMessage] = useState("");
  const [bulkSmsSending, setBulkSmsSending] = useState(false);
  const [uploadFile, setUploadFile] = useState<File[] | null>(null);
  
  const currentMonth = useMemo(getCurrentMonthDates, []);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: currentMonth.startDate,
    endDate: currentMonth.endDate,
    region: "all",
    gender: "all"
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const processedKeysRef = useRef<Set<string>>(new Set());

  const [stats, setStats] = useState<Stats>({
    totalRegions: 0,
    totalAnimals: 0,
    totalRevenue: 0,
    averageLiveWeight: 0,
    averageCarcassWeight: 0,
    averageRevenue: 0,
    totalFarmers: 0,
    totalMaleFarmers: 0,
    totalFemaleFarmers: 0,
    avgPricePerCarcassKg: 0
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  });

  const [editForm, setEditForm] = useState<EditForm>({
    date: "",
    farmerName: "",
    gender: "",
    idNumber: "",
    phoneNumber: "",
    region: "",
    location: ""
  });

  const [weightEditForm, setWeightEditForm] = useState<WeightEditForm>({
    liveWeights: [],
    carcassWeights: [],
    prices: []
  });

  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes);
  
  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };

  // Debounce Search Input
  useEffect(() => {
    const delay = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: localSearchInput }));
      setPagination(prev => ({ ...prev, page: 1 }));
    }, 500);

    return () => clearTimeout(delay);
  }, [localSearchInput]);

  // CSV Line Parsing (Handles Quotes Safely)
  const parseCSVLine = (text: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  };

  const parseCSVFile = (file: File): Promise<any[]> => new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const text = e.target?.result as string;
      const rows = text.split('\n').filter(r => r.trim() !== '');

      if (rows.length < 2) {
        toast({ title: "Error", description: "CSV file is empty or invalid.", variant: "destructive" });
        resolve([]);
        return;
      }

      const rawHeaders = parseCSVLine(rows[0]);
      const headers = rawHeaders.map(h => ({
        original: h.trim(),
        clean: h.trim().toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ')
      }));

      const findIndex = (keys: string[]) => headers.findIndex(h => keys.some(k => h.clean.includes(k)));

      const idxDate = findIndex(['date']);
      const idxName = findIndex(['farmer name', 'name']);
      const idxGender = findIndex(['gender']);
      const idxId = findIndex(['id number', 'idnumber', 'id']);
      const idxPhone = findIndex(['phone number', 'phone']);
      const idxCounty = findIndex(['county', 'region']);
      const idxSub = findIndex(['subcounty', 'sub county']);
      const idxLoc = findIndex(['location', 'village']);
      const idxProg = findIndex(['programme']);
      const idxUser = findIndex(['username', 'user']);
      const idxUserId = findIndex(['user id', 'offtake user id']);

      const idxPricePerAnimal = findIndex(['price per animal', 'price per goat', 'price per sheep']);
      const idxPrice = idxPricePerAnimal !== -1 ? idxPricePerAnimal : findIndex(['price']);
      const idxLive = headers.findIndex(h => h.clean.startsWith('live weight'));
      const idxCarcass = headers.findIndex(h => h.clean.startsWith('carcass weight'));

      const animalColumnMap = new Map<number, { live?: number; carcass?: number; price?: number; number?: number }>();
      headers.forEach((h, i) => {
        const match = h.clean.match(/(\d+)/);
        if (!match) return;
        const num = parseInt(match[1], 10);
        if (Number.isNaN(num)) return;

        const isLive = h.clean.includes('live weight');
        const isCarcass = h.clean.includes('carcass weight') || h.clean.includes('carcass');
        const isPrice = h.clean.includes('price');
        const isGoatNo = h.clean.includes('goat') && (h.clean.includes('number') || h.clean.includes('no'));

        if (!isLive && !isCarcass && !isPrice && !isGoatNo) return;
        const existing = animalColumnMap.get(num) || {};
        if (isLive) existing.live = i;
        if (isCarcass) existing.carcass = i;
        if (isPrice) existing.price = i;
        if (isGoatNo) existing.number = i;
        animalColumnMap.set(num, existing);
      });

      const animalColumnIndices = Array.from(animalColumnMap.keys()).sort((a, b) => a - b);
      const hasMultiAnimalColumns = animalColumnIndices.length > 0;
      const transactionsMap = new Map<string, any>();
      let lastTransactionKey: string | null = null;

      const buildGoatsFromMultiColumnRow = (cols: string[]) => {
        const goats: { live: string; carcass: string; price: string }[] = [];
        for (const idx of animalColumnIndices) {
          const col = animalColumnMap.get(idx);
          const liveVal = col?.live !== undefined ? cols[col.live] : '';
          const carcassVal = col?.carcass !== undefined ? cols[col.carcass] : '';
          const priceVal = col?.price !== undefined ? cols[col.price] : (idxPrice !== -1 ? cols[idxPrice] : '');

          if (![liveVal, carcassVal, priceVal].some(v => v && v.trim() !== '')) continue;
          goats.push({
            live: liveVal ? cleanNumber(liveVal).toFixed(1) : '',
            carcass: carcassVal ? cleanNumber(carcassVal).toFixed(2) : '',
            price: priceVal ? cleanNumber(priceVal).toFixed(2) : ''
          });
        }
        return goats;
      };

      const buildGoatsFromSingleRow = (cols: string[]) => {
        const goats: { live: string; carcass: string; price: string }[] = [];
        const liveVal = idxLive !== -1 ? cols[idxLive] : '';
        const carcassVal = idxCarcass !== -1 ? cols[idxCarcass] : '';
        const priceVal = idxPrice !== -1 ? cols[idxPrice] : '';

        if (![liveVal, carcassVal, priceVal].some(v => v && v.trim() !== '')) return goats;
        goats.push({
          live: liveVal ? cleanNumber(liveVal).toFixed(1) : '',
          carcass: carcassVal ? cleanNumber(carcassVal).toFixed(2) : '',
          price: priceVal ? cleanNumber(priceVal).toFixed(2) : ''
        });
        return goats;
      };

      for (let i = 1; i < rows.length; i++) {
        const cols = parseCSVLine(rows[i]);
        if (!cols || cols.every(c => !c.trim())) continue;

        const firstColVal = (cols[0] || '').trim().toUpperCase();
        if (firstColVal.startsWith('GRAND TOTAL') || firstColVal === 'TOTAL') continue;

        const rawId = idxId !== -1 ? cols[idxId]?.trim() : '';
        const rawDate = cols[idxDate]?.trim() || '';
        const hasFarmerDetails = [idxName, idxPhone, idxCounty, idxSub, idxLoc, idxProg].some((idx) => idx !== -1 && Boolean(cols[idx]?.trim()));
        const isHeaderRow = !!(rawDate && (!isMissingFarmerId(rawId) || hasFarmerDetails));

        const generatedSeed = `${rawDate}_${cols[idxName] || ''}_${cols[idxPhone] || ''}_${i}`;
        const id = resolveFarmerId(rawId, generatedSeed, {
          name: (cols[idxName] || '').trim(),
          phone: (cols[idxPhone] || '').trim(),
          location: (cols[idxLoc] || cols[idxCounty] || '').trim(),
        });
        const uniqueKey = isHeaderRow ? `${id}_${rawDate}` : (lastTransactionKey || '');
        if (!uniqueKey) continue;

        if (isHeaderRow && !transactionsMap.has(uniqueKey)) {
          const loc = (cols[idxLoc] || cols[idxCounty] || 'UNK').trim();
          const prefix = loc.substring(0, 3).toUpperCase();
          const generatedUserId = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
          let formattedDate = rawDate;
          const parsedDate = parseDate(rawDate);
          if (parsedDate) {
            formattedDate = formatDateToLocal(parsedDate);
          }

          let rawPhone = (cols[idxPhone] || '').trim();
          if (rawPhone === '0' || rawPhone === '0.0') rawPhone = '';

          transactionsMap.set(uniqueKey, {
            date: formattedDate,
            name: (cols[idxName] || '').trim(),
            gender: (cols[idxGender] || '').trim(),
            idNumber: id,
            phone: rawPhone,
            county: (cols[idxCounty] || '').trim(),
            subcounty: (cols[idxSub] || '').trim(),
            location: loc,
            programme: (cols[idxProg] || activeProgram).trim(),
            username: (cols[idxUser] || '').trim() || auth.currentUser?.displayName || auth.currentUser?.email || 'admin',
            createdAt: parsedDate ? parsedDate.getTime() : 0,
            offtakeUserId: idxUserId !== -1 ? (cols[idxUserId] || '').trim() : generatedUserId,
            goats: []
          });
        }

        const transaction = transactionsMap.get(uniqueKey);
        if (!transaction) continue;
        lastTransactionKey = uniqueKey;

        const goats = hasMultiAnimalColumns ? buildGoatsFromMultiColumnRow(cols) : buildGoatsFromSingleRow(cols);
        goats.forEach(goat => transaction.goats.push(goat));
      }

      const transactions = Array.from(transactionsMap.values());
      if (transactions.length === 0) {
        toast({ title: "No Data", description: "No valid transactions found.", variant: "destructive" });
        resolve([]);
      } else {
        toast({ title: "Parsed Successfully", description: `Found ${transactions.length} transactions` });
        resolve(transactions);
      }
    };
    reader.readAsText(file);
  });

  // Realtime Subscriptions
  useEffect(() => {
    if (!activeProgram) {
      setAllOfftake([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = subscribeCollectionByProgramme<Record<string, any>>("offtakes", activeProgram, (data) => {
      if (!data || Object.keys(data).length === 0) {
        setAllOfftake([]);
        setLoading(false);
        return;
      }

      const missingIdUpdates: Record<string, string> = {};
      const offtakeList = Object.keys(data).map((key) => {
        const item = data[key];
        const parsedItemDate = parseDate(item.date);
        const dateValue: Date | string = parsedItemDate ?? item.date;

        const liveWeights = (item.goats || []).map((g: any) => parseFloat(g.live) || 0);
        const carcassWeights = (item.goats || []).map((g: any) => parseFloat(g.carcass) || 0);
        const prices = (item.goats || []).map((g: any) => parseFloat(g.price) || 0);

        const resolvedIdNumber = resolveFarmerId(item.idNumber, key, {
          name: item.name || item.farmerName || '',
          phone: item.phone || item.phoneNumber || '',
          location: item.location || item.county || '',
        });

        if (isMissingFarmerId(item.idNumber)) {
          missingIdUpdates[`offtakes/${key}/idNumber`] = resolvedIdNumber;
        }

        return {
          id: key,
          date: dateValue,
          farmerName: item.name || '', 
          gender: item.gender || '',
          idNumber: resolvedIdNumber,
          liveWeight: liveWeights,
          carcassWeight: carcassWeights,
          location: item.location || '',
          noSheepGoats: Number(item.totalGoats || (item.goats || []).length || 0),
          phoneNumber: item.phone || '', 
          pricePerGoatAndSheep: prices,
          region: item.county || '', 
          programme: item.programme || activeProgram, 
          subcounty: item.subcounty || '', 
          username: item.username || '',
          offtakeUserId: item.offtakeUserId || '',
          totalprice: Number(item.totalPrice || 0),
          createdAt: Number(item.createdAt || parsedItemDate?.getTime() || 0)
        };
      }).filter((record) => matchesActiveProgramme(record.programme, activeProgram));

      if (Object.keys(missingIdUpdates).length > 0) {
        const newUpdates: Record<string, string> = {};
        for (const [path, idValue] of Object.entries(missingIdUpdates)) {
          const key = path.replace('offtakes/', '');
          if (!processedKeysRef.current.has(key)) {
            newUpdates[path] = idValue;
            processedKeysRef.current.add(key);
          }
        }
        if (Object.keys(newUpdates).length > 0) {
          update(ref(db), newUpdates).catch(err => console.error("Failed to backfill IDs:", err));
        }
      }

      setAllOfftake(sortOfftakeByLatest(offtakeList));
      setLoading(false);
    }, (error) => {
      console.error(error);
      toast({ title: "Error", description: "Failed to load database stream.", variant: "destructive" });
      setLoading(false);
    }, { noDateFilter: true, ttlMs: 30 * 60 * 1000 });

    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [activeProgram, toast]);

  // Filtering System
  useEffect(() => {
    if (allOfftake.length === 0) {
      setFilteredOfftake([]);
      setStats({
        totalRegions: 0, totalAnimals: 0, totalRevenue: 0, averageLiveWeight: 0,
        averageCarcassWeight: 0, averageRevenue: 0, totalFarmers: 0,
        totalMaleFarmers: 0, totalFemaleFarmers: 0, avgPricePerCarcassKg: 0
      });
      return;
    }

    const filtered = allOfftake.filter(record => {
      if (filters.region !== "all" && record.region?.toLowerCase() !== filters.region.toLowerCase()) return false;
      if (filters.gender !== "all" && record.gender?.toLowerCase() !== filters.gender.toLowerCase()) return false;

      if (filters.startDate || filters.endDate) {
        const parsedRecordDate = parseDate(record.date);
        const recordTimestamp = parsedRecordDate ? parsedRecordDate.getTime() : (record.createdAt || 0);
        if (!recordTimestamp) return false;

        const recordDateOnly = new Date(recordTimestamp);
        recordDateOnly.setHours(0, 0, 0, 0);

        const startDate = filters.startDate ? parseDateInputValue(filters.startDate) : null;
        const endDate = filters.endDate ? parseDateInputValue(filters.endDate) : null;

        if (startDate) startDate.setHours(0, 0, 0, 0);
        if (endDate) endDate.setHours(23, 59, 59, 999);

        if (startDate && recordDateOnly < startDate) return false;
        if (endDate && recordDateOnly > endDate) return false;
      }

      if (filters.search) {
        const searchTerm = filters.search.toLowerCase();
        return [record.farmerName, record.location, record.region, record.subcounty, record.idNumber, record.phoneNumber, record.offtakeUserId]
          .some(field => field?.toLowerCase().includes(searchTerm));
      }
      return true;
    });

    const sortedFiltered = sortOfftakeByLatest(filtered);
    setFilteredOfftake(sortedFiltered);
    
    const totalAnimals = sortedFiltered.reduce((sum, r) => sum + (r.noSheepGoats || 0), 0);
    const totalRevenue = sortedFiltered.reduce((sum, r) => sum + (r.totalprice || 0), 0);
    const uniqueRegions = new Set(sortedFiltered.map(f => f.region).filter(Boolean));

    let totalMaleFarmers = 0, totalFemaleFarmers = 0;
    sortedFiltered.forEach(r => {
      if (r.gender?.toLowerCase() === 'male') totalMaleFarmers++;
      else if (r.gender?.toLowerCase() === 'female') totalFemaleFarmers++;
    });

    const totalLiveWeight = sortedFiltered.reduce((sum, r) => sum + calculateTotal(r.liveWeight), 0);
    const totalCarcassWeight = sortedFiltered.reduce((sum, r) => sum + calculateTotal(r.carcassWeight), 0);
    
    setStats({
      totalRegions: uniqueRegions.size,
      totalAnimals,
      totalRevenue,
      averageLiveWeight: totalAnimals > 0 ? totalLiveWeight / totalAnimals : 0,
      averageCarcassWeight: totalAnimals > 0 ? totalCarcassWeight / totalAnimals : 0,
      averageRevenue: totalAnimals > 0 ? totalRevenue / totalAnimals : 0,
      totalFarmers: sortedFiltered.length,
      totalMaleFarmers,
      totalFemaleFarmers,
      avgPricePerCarcassKg: totalCarcassWeight > 0 ? totalRevenue / totalCarcassWeight : 0
    });

    const totalPages = Math.ceil(sortedFiltered.length / pagination.limit);
    const currentPage = Math.min(pagination.page, Math.max(1, totalPages));
    setPagination(prev => ({ ...prev, page: currentPage, totalPages, hasNext: currentPage < totalPages, hasPrev: currentPage > 1 }));
  }, [allOfftake, filters, pagination.limit]);

  // Handlers
  const handleProgramChange = (program: string) => {
    setActiveProgram(program);
    processedKeysRef.current.clear();
    setFilters({ search: "", startDate: currentMonth.startDate, endDate: currentMonth.endDate, region: "all", gender: "all" });
    setLocalSearchInput("");
    setPagination(prev => ({ ...prev, page: 1 }));
    setSelectedRecords([]);
  };

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const handleLocalSearchChange = useCallback((value: string) => {
    setLocalSearchInput(value);
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    setPagination(prev => {
      const totalPages = Math.ceil(filteredOfftake.length / prev.limit);
      const validatedPage = Math.max(1, Math.min(newPage, totalPages));
      return { ...prev, page: validatedPage, hasNext: validatedPage < totalPages, hasPrev: validatedPage > 1 };
    });
  }, [filteredOfftake.length]);

  const currentPageRecords = useMemo(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    return filteredOfftake.slice(startIndex, startIndex + pagination.limit);
  }, [filteredOfftake, pagination.page, pagination.limit]);

  const handleSelectRecord = useCallback((recordId: string) => {
    setSelectedRecords(prev => prev.includes(recordId) ? prev.filter(id => id !== recordId) : [...prev, recordId]);
  }, []);

  const handleSelectAll = useCallback(() => {
    const currentPageIds = currentPageRecords.map(f => f.id);
    setSelectedRecords(prev => prev.length === currentPageIds.length ? [] : currentPageIds);
  }, [currentPageRecords]);

  // Exporters
  const handleExport = async () => {
    try {
      setExportLoading(true);
      if (filteredOfftake.length === 0) {
        toast({ title: "No Data to Export", description: "There are no records matching your filters", variant: "destructive" });
        return;
      }

      const headers = ['Date', 'Farmer Name', 'Gender', 'ID Number', 'Programme', 'Region (County)', 'Subcounty', 'Location', 'Phone Number', 'Total Animals', 'Live Weight (kg)', 'Carcass Weight (kg)', 'Price per Animal (KES)', 'Total Price (KES)'];
      const csvData: any[] = [];

      filteredOfftake.forEach(record => {
        const liveWeights = record.liveWeight || [];
        const carcassWeights = record.carcassWeight || [];
        const prices = record.pricePerGoatAndSheep || [];
        const numAnimals = Math.max(liveWeights.length, carcassWeights.length, prices.length, record.noSheepGoats || 1);

        for (let i = 0; i < numAnimals; i++) {
          csvData.push([
            i === 0 ? formatDate(record.date) : '',
            i === 0 ? (record.farmerName || 'N/A') : '',
            i === 0 ? (record.gender || 'N/A') : '',
            i === 0 ? (record.idNumber || 'N/A') : '',
            i === 0 ? (record.programme || 'N/A') : '',
            i === 0 ? (record.region || 'N/A') : '',
            i === 0 ? (record.subcounty || 'N/A') : '',
            i === 0 ? (record.location || 'N/A') : '',
            i === 0 ? (record.phoneNumber || 'N/A') : '',
            i === 0 ? (record.noSheepGoats || 0).toString() : '',
            liveWeights[i] > 0 ? liveWeights[i].toFixed(1) : '',
            carcassWeights[i] > 0 ? carcassWeights[i].toFixed(2) : '',
            prices[i] > 0 ? prices[i].toFixed(2) : '',
            i === 0 ? (record.totalprice || 0).toFixed(2) : ''
          ]);
        }
        csvData.push(Array(headers.length).fill(''));
      });

      const csvContent = [headers, ...csvData].map(row => row.map(f => `"${f}"`).join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `livestock-offtake-${activeProgram}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error(err);
    } finally { setExportLoading(false); }
  };

  const handleExportAggregatedByFarmer = async () => {
    try {
      setExportLoading(true);
      if (filteredOfftake.length === 0) return;

      const groupedFarmers = new Map<string, any>();
      filteredOfftake.forEach((record) => {
        const groupKey = getFarmerGroupingKey(record);
        const existing = groupedFarmers.get(groupKey);
        const liveWeightSum = calculateTotal(record.liveWeight);
        const carcassWeightSum = calculateTotal(record.carcassWeight);

        if (!existing) {
          groupedFarmers.set(groupKey, {
            idNumber: record.idNumber || 'N/A', farmerName: record.farmerName || 'N/A', gender: record.gender || 'N/A',
            programme: record.programme || 'N/A', region: record.region || 'N/A', subcounty: record.subcounty || 'N/A',
            location: record.location || 'N/A', phoneNumber: record.phoneNumber || 'N/A', sessions: 1,
            totalAnimals: Number(record.noSheepGoats) || 0, totalLiveWeight: liveWeightSum, totalCarcassWeight: carcassWeightSum, totalRevenue: Number(record.totalprice) || 0
          });
        } else {
          existing.sessions += 1;
          existing.totalAnimals += Number(record.noSheepGoats) || 0;
          existing.totalLiveWeight += liveWeightSum;
          existing.totalCarcassWeight += carcassWeightSum;
          existing.totalRevenue += Number(record.totalprice) || 0;
        }
      });

      const headers = ['ID Number', 'Farmer Name', 'Gender', 'Programme', 'Region (County)', 'Subcounty', 'Location', 'Phone Number', 'Sessions', 'Total Animals', 'Total Live Weight (kg)', 'Total Carcass Weight (kg)', 'Total Revenue (KES)'];
      const csvRows = Array.from(groupedFarmers.values()).map(f => [f.idNumber, f.farmerName, f.gender, f.programme, f.region, f.subcounty, f.location, f.phoneNumber, f.sessions.toString(), f.totalAnimals.toString(), f.totalLiveWeight.toFixed(1), f.totalCarcassWeight.toFixed(2), f.totalRevenue.toFixed(2)]);
      
      const csvContent = [headers, ...csvRows].map(row => row.map(f => `"${f}"`).join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `aggregated-farmers-${activeProgram}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) { console.error(err); } finally { setExportLoading(false); }
  };

  const handleExportFarmerOfftakeSummary = async () => {
    try {
      setExportLoading(true);
      if (filteredOfftake.length === 0) return;

      const summaries = new Map<string, any>();
      filteredOfftake.forEach((record) => {
        const key = (record.farmerName || "N/A").trim().toLowerCase();
        const existing = summaries.get(key);
        const liveTotal = calculateTotal(record.liveWeight);
        const carcassTotal = calculateTotal(record.carcassWeight);

        if (!existing) {
          summaries.set(key, {
            farmerName: record.farmerName, latestDate: formatDate(record.date), latestTimestamp: getOfftakeTimestamp(record),
            totalAnimals: record.noSheepGoats, carcassWeightTotal: carcassTotal, carcassCount: record.carcassWeight.length,
            liveWeightTotal: liveTotal, liveCount: record.liveWeight.length, priceTotal: record.totalprice, priceCount: 1
          });
        } else {
          if (getOfftakeTimestamp(record) > existing.latestTimestamp) {
            existing.latestDate = formatDate(record.date);
            existing.latestTimestamp = getOfftakeTimestamp(record);
          }
          existing.totalAnimals += record.noSheepGoats;
          existing.carcassWeightTotal += carcassTotal;
          existing.carcassCount += record.carcassWeight.length;
          existing.liveWeightTotal += liveTotal;
          existing.liveCount += record.liveWeight.length;
          existing.priceTotal += record.totalprice;
          existing.priceCount += 1;
        }
      });

      const headers = ["Date", "Farmer Name", "Number of Animals", "Average Carcass Weight (kg)", "Average Live Weight (kg)", "Average Price (KES)"];
      const rows = Array.from(summaries.values()).map(s => [
        s.latestDate, s.farmerName, s.totalAnimals.toString(),
        (s.carcassCount > 0 ? s.carcassWeightTotal / s.carcassCount : 0).toFixed(2),
        (s.liveCount > 0 ? s.liveWeightTotal / s.liveCount : 0).toFixed(1),
        (s.priceCount > 0 ? s.priceTotal / s.priceCount : 0).toFixed(2)
      ]);

      const csvContent = [headers, ...rows].map(row => row.map(f => `"${f}"`).join(',')).join('\n');
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `farmer-summary-${activeProgram}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) { console.error(err); } finally { setExportLoading(false); }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setUploadFile(files);
    setUploadProgress({ current: 0, total: 0 });
    const parsedSets = await Promise.all(files.map(parseCSVFile));
    setUploadPreview(parsedSets.flat());
  };

  const getUploadDateRange = (records: readonly any[]): Pick<Filters, "startDate" | "endDate"> | null => {
    const timestamps = records
      .map((record) => parseDate(record?.date)?.getTime() || Number(record?.createdAt || 0))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
    if (timestamps.length === 0) return null;
    return {
      startDate: formatDateToLocal(new Date(Math.min(...timestamps))),
      endDate: formatDateToLocal(new Date(Math.max(...timestamps))),
    };
  };

  // Safe Non-Blocking Bulk Uploader
  const handleUpload = async () => {
    if (!requireAdmin()) return;
    if (uploadPreview.length === 0) {
      toast({ title: "Error", description: "No data to upload", variant: "destructive" });
      return;
    }

    try {
      setUploadLoading(true);
      const totalRecords = uploadPreview.length;
      setUploadProgress({ current: 0, total: totalRecords });

      const BATCH_SIZE = 100; // Smaller chunk sizes yield better UI responsiveness
      let processedCount = 0;
      const uploadedRecords: OfftakeData[] = [];

      const processBatch = async (startIndex: number) => {
        if (startIndex >= totalRecords) {
          const uploadedRange = getUploadDateRange(uploadedRecords.length > 0 ? uploadedRecords : uploadPreview);
          if (uploadedRange) {
            setFilters((current) => ({ ...current, startDate: uploadedRange.startDate, endDate: uploadedRange.endDate }));
            setPagination((current) => ({ ...current, page: 1 }));
          }

          setUploadLoading(false);
          setIsUploadDialogOpen(false);
          setUploadFile(null);
          setUploadPreview([]);
          setUploadProgress({ current: 0, total: 0 });
          toast({ title: "Upload Successful", description: `Uploaded ${uploadedRecords.length} transactions successfully.` });
          return;
        }

        const endIndex = Math.min(startIndex + BATCH_SIZE, totalRecords);
        const batch = uploadPreview.slice(startIndex, endIndex);
        const uploadedInBatch: OfftakeData[] = [];

        // Correctly handling mapping via async Promise awaiting
        await Promise.all(batch.map(async (record) => {
          try {
            const totalGoats = record.goats.length;
            const totalPrice = record.goats.reduce((sum: number, g: any) => sum + (parseFloat(g.price) || 0), 0);
            const generatedCreatedAt = record.createdAt || Date.now();

            const recordData = {
              county: record.county, createdAt: generatedCreatedAt, date: record.date, gender: record.gender,
              idNumber: record.idNumber, location: record.location, name: record.name, offtakeUserId: record.offtakeUserId,
              phone: record.phone, programme: record.programme, subcounty: record.subcounty, username: record.username,
              totalGoats, totalPrice, goats: record.goats
            };

            const newRef = await push(ref(db, 'offtakes'), recordData);
            const newKey = newRef?.key;
            if (!newKey) return;

            uploadedInBatch.push({
              id: newKey,
              date: parseDate(recordData.date) || recordData.date,
              farmerName: String(recordData.name || ""),
              gender: String(recordData.gender || ""),
              idNumber: String(recordData.idNumber || ""),
              liveWeight: record.goats.map((g: any) => parseFloat(g.live) || 0),
              carcassWeight: record.goats.map((g: any) => parseFloat(g.carcass) || 0),
              location: String(recordData.location || ""),
              noSheepGoats: Number(totalGoats || 0),
              phoneNumber: String(recordData.phone || ""),
              pricePerGoatAndSheep: record.goats.map((g: any) => parseFloat(g.price) || 0),
              region: String(recordData.county || ""),
              programme: String(recordData.programme || activeProgram),
              subcounty: String(recordData.subcounty || ""),
              username: String(recordData.username || ""),
              offtakeUserId: String(recordData.offtakeUserId || ""),
              totalprice: Number(totalPrice || 0),
              createdAt: Number(generatedCreatedAt)
            });
          } catch (err) { console.error("Error pushing single record:", err); }
        }));

        if (uploadedInBatch.length > 0) {
          uploadedRecords.push(...uploadedInBatch);
          setAllOfftake((current) => {
            const nextById = new Map(current.map((r) => [r.id, r]));
            uploadedInBatch.forEach((r) => nextById.set(r.id, r));
            return sortOfftakeByLatest(Array.from(nextById.values()));
          });
          processedCount += uploadedInBatch.length;
          setUploadProgress({ current: processedCount, total: totalRecords });
        }

        setTimeout(() => processBatch(endIndex), 0);
      };

      await processBatch(0);
    } catch (error) {
      console.error(error);
      setUploadLoading(false);
      toast({ title: "Upload Failed", description: "Internal submission error.", variant: "destructive" });
    }
  };

  // Dialog Toggles
  const openViewDialog = useCallback((record: OfftakeData) => { setViewingRecord(record); setIsViewDialogOpen(true); }, []);
  const openEditDialog = useCallback((record: OfftakeData) => {
    if (!userIsAdmin) return;
    setViewingRecord(record);
    setEditForm({
      date: formatDateForInput(record.date), farmerName: record.farmerName || "", gender: record.gender || "",
      idNumber: record.idNumber || "", phoneNumber: record.phoneNumber || "", region: record.region || "", location: record.location || ""
    });
    setIsEditDialogOpen(true);
  }, [userIsAdmin]);

  const openWeightEditDialog = useCallback((record: OfftakeData) => {
    if (!userIsAdmin) return;
    setViewingRecord(record);
    const live = record.liveWeight || [];
    const carcass = record.carcassWeight || [];
    const prices = record.pricePerGoatAndSheep || [];
    const len = Math.max(live.length, carcass.length, prices.length, record.noSheepGoats || 1);

    const pad = (arr: number[]) => [...arr, ...Array(Math.max(0, len - arr.length)).fill(0)];
    setWeightEditForm({ liveWeights: pad(live), carcassWeights: pad(carcass), prices: pad(prices) });
    setIsWeightEditDialogOpen(true);
  }, [userIsAdmin]);

  const openSingleDeleteConfirm = useCallback((record: OfftakeData) => { if (!userIsAdmin) return; setRecordToDelete(record); setIsSingleDeleteDialogOpen(true); }, [userIsAdmin]);
  const openBulkDeleteConfirm = () => { if (requireAdmin() && selectedRecords.length > 0) setIsDeleteConfirmOpen(true); };
  const openBulkSmsDialog = () => { if (selectedRecords.length > 0) setIsBulkSmsDialogOpen(true); };

  const handleSingleDelete = async () => {
    if (!requireAdmin() || !recordToDelete) return;
    try {
      setDeleteLoading(true);
      await remove(ref(db, `offtakes/${recordToDelete.id}`));
      setAllOfftake(curr => curr.filter(r => r.id !== recordToDelete.id));
      setSelectedRecords(p => p.filter(id => id !== recordToDelete.id));
      setIsSingleDeleteDialogOpen(false);
      toast({ title: "Success", description: "Record deleted" });
    } catch (err) { console.error(err); } finally { setDeleteLoading(false); }
  };

  const handleDeleteMultiple = async () => {
    if (!requireAdmin() || selectedRecords.length === 0) return;
    try {
      setDeleteLoading(true);
      await Promise.all(selectedRecords.map(id => remove(ref(db, `offtakes/${id}`))));
      const targetSet = new Set(selectedRecords);
      setAllOfftake(curr => curr.filter(r => !targetSet.has(r.id)));
      setSelectedRecords([]);
      setIsDeleteConfirmOpen(false);
      toast({ title: "Success", description: "Bulk items purged" });
    } catch (err) { console.error(err); } finally { setDeleteLoading(false); }
  };

  const handleSendBulkSms = async () => {
    const msg = bulkSmsMessage.trim();
    if (!msg) return;
    setBulkSmsSending(true);
    try {
      const activeSet = new Set(selectedRecords);
      const targets = allOfftake.filter(r => activeSet.has(r.id));
      const numbers = Array.from(new Set(targets.map(t => t.phoneNumber).filter(Boolean)));

      if (numbers.length === 0) {
        toast({ title: "Failure", description: "No valid destination phone lines found", variant: "destructive" });
        return;
      }

      await push(ref(db, "smsOutbox"), {
        status: "pending", sourcePage: "livestock-offtake", programme: activeProgram, createdAt: Date.now(),
        createdBy: auth.currentUser?.email || "unknown", message: msg, recipients: numbers, selectedRecordCount: selectedRecords.length
      });

      setIsBulkSmsDialogOpen(false);
      setBulkSmsMessage("");
      toast({ title: "Success", description: "Bulk text dispatches successfully scheduled." });
    } catch (err) { console.error(err); } finally { setBulkSmsSending(false); }
  };

  const handleEditSubmit = async () => {
    if (!requireAdmin() || !viewingRecord) return;
    try {
      // Direct formatted assignment string helps parsing correctly 
      const updatePayload = {
        date: editForm.date ? editForm.date : null,
        name: editForm.farmerName, gender: editForm.gender, idNumber: editForm.idNumber,
        phone: editForm.phoneNumber, county: editForm.region, location: editForm.location
      };
      await update(ref(db, `offtakes/${viewingRecord.id}`), updatePayload);
      setIsEditDialogOpen(false);
      toast({ title: "Success", description: "Farmer updates committed." });
    } catch (err) { console.error(err); }
  };

  const handleWeightEditSubmit = async () => {
    if (!requireAdmin() || !viewingRecord) return;
    try {
      const live = weightEditForm.liveWeights.filter(w => w > 0);
      const carcass = weightEditForm.carcassWeights.filter(w => w > 0);
      const prices = weightEditForm.prices.filter(p => p > 0);

      const combinedGoats = live.map((l, i) => ({
        live: String(l.toFixed(1)), carcass: String((carcass[i] || 0).toFixed(2)), price: String((prices[i] || 0).toFixed(2))
      }));
      const totalCost = prices.reduce((a, b) => a + b, 0);

      await update(ref(db, `offtakes/${viewingRecord.id}`), { goats: combinedGoats, totalGoats: combinedGoats.length, totalPrice: totalCost });
      setIsWeightEditDialogOpen(false);
      toast({ title: "Success", description: "Animal aggregates adjusted successfully" });
    } catch (err) { console.error(err); }
  };

  const clearAllFilters = useCallback(() => {
    setFilters({ search: "", startDate: "", endDate: "", region: "all", gender: "all" });
    setLocalSearchInput("");
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const resetToCurrentMonth = useCallback(() => {
    setFilters(prev => ({ ...prev, startDate: currentMonth.startDate, endDate: currentMonth.endDate }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [currentMonth]);

  const uniqueRegions = useMemo(() => [...new Set(allOfftake.map(f => f.region).filter(Boolean))], [allOfftake]);
  const uniqueGenders = useMemo(() => [...new Set(allOfftake.map(f => f.gender).filter(Boolean))], [allOfftake]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-md font-bold mb-2 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Livestock Offtake Data
          </h2>
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 font-bold px-3 py-1 w-fit">
            {userCanViewAllProgrammeData ? `${activeProgram} PROGRAMME` : activeProgram}
          </Badge>
        </div>
        
        <div className="flex flex-wrap gap-2 items-center w-full xl:w-auto">
          {accessibleProgrammes.length > 1 && (
            <div className="mr-4">
              <Select value={activeProgram} onValueChange={handleProgramChange}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white w-full sm:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accessibleProgrammes.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {selectedRecords.length > 0 && isAdmin(userRole) && (
            <Button variant="destructive" size="sm" onClick={openBulkDeleteConfirm} disabled={deleteLoading} className="text-xs">
              <Trash2 className="h-4 w-4 mr-2" /> Delete ({selectedRecords.length})
            </Button>
          )}
          {selectedRecords.length > 0 && (
            <Button variant="outline" size="sm" onClick={openBulkSmsDialog} className="text-xs border-green-300 text-green-700 hover:bg-green-50">
              <Phone className="h-4 w-4 mr-2" /> Send SMS ({selectedRecords.length})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={clearAllFilters} className="text-xs border-gray-300 hover:bg-gray-50">Clear Filters</Button>
          <Button variant="outline" size="sm" onClick={resetToCurrentMonth} className="text-xs border-gray-300 hover:bg-gray-50">This Month</Button>
          <Button variant="outline" size="sm" onClick={() => setIsUploadDialogOpen(true)} className="text-xs border-gray-300 hover:bg-blue-50 hover:text-blue-600">
            <Upload className="h-4 w-4 mr-2" /> Upload Data
          </Button>

          {isAdmin(userRole) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={exportLoading || filteredOfftake.length === 0} className="bg-gradient-to-r from-blue-800 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-md text-xs">
                  <Download className="h-4 w-4 mr-2" /> {exportLoading ? "Exporting..." : `Export (${filteredOfftake.length})`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={handleExport}><Download className="h-4 w-4 mr-2" /> Export Detailed Data</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExportAggregatedByFarmer}><Users className="h-4 w-4 mr-2" /> Export Summed by Farmer ID</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExportFarmerOfftakeSummary}><Users className="h-4 w-4 mr-2" /> Export Farmer Summary</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard title="TOTAL FARMERS" value={stats.totalFarmers.toLocaleString()} icon={Users} description={`${stats.totalMaleFarmers} Males | ${stats.totalFemaleFarmers} Females`} />
        <StatsCard title="TOTAL ANIMALS" value={stats.totalAnimals.toLocaleString()} icon={Scale} description={`Avg Live: ${stats.averageLiveWeight.toFixed(1)}kg | Avg Carcass: ${stats.averageCarcassWeight.toFixed(1)}kg`} />
        <StatsCard title="TOTAL COST" value={safeTruncate(formatCurrency(stats.totalRevenue))} icon={CreditCard} description={`Avg Price: ${formatCurrency(stats.averageRevenue)} | Avg per Kg: ${formatCurrency(stats.avgPricePerCarcassKg)}`} />
      </div>

      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-4 pt-6">
          <FilterSection localSearchInput={localSearchInput} filters={filters} uniqueRegions={uniqueRegions} uniqueGenders={uniqueGenders} onSearchChange={handleLocalSearchChange} onFilterChange={handleFilterChange} />
        </CardContent>
      </Card>

      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-muted-foreground mt-2">Loading stream allocations...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No matching livestock profiles active.</div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-100">
                      <th className="py-2 px-4">
                        <Checkbox checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0} onCheckedChange={handleSelectAll} />
                      </th>
                      <th className="py-2 px-4 font-medium text-gray-600">Date</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Farmer Name</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Gender</th>
                      <th className="py-2 px-4 font-medium text-gray-600">ID No</th>
                      <th className="py-2 px-4 font-medium text-gray-600">County</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Sub County</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Village</th>
                      <th className="py-2 px-4 font-medium text-gray-600">No.Animals</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Total Price</th>
                      <th className="py-2 px-4 font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <tr key={record.id} className="border-b hover:bg-blue-50 transition-all text-sm">
                        <td className="py-1 px-4">
                          <Checkbox checked={selectedRecords.includes(record.id)} onCheckedChange={() => handleSelectRecord(record.id)} />
                        </td>
                        <td className="py-1 px-6 text-xs">{formatDate(record.date)}</td>
                        <td className="py-1 px-6 text-xs">{record.farmerName || 'N/A'}</td>
                        <td className="py-1 px-6 text-xs">{record.gender || 'N/A'}</td>
                        <td className="py-1 px-6 text-xs">
                          <code className="text-sm bg-gray-100 px-2 py-1 rounded text-gray-700">{record.idNumber || record.offtakeUserId || 'N/A'}</code>
                        </td>
                        <td className="py-1 px-6 text-xs">{record.region || 'N/A'}</td>
                        <td className="py-1 px-6 text-xs">{record.subcounty || 'N/A'}</td>
                        <td className="py-1 px-6 text-xs">{record.location || 'N/A'}</td>
                        <td className="py-1 px-6 text-xs font-bold">{record.noSheepGoats || 0}</td>
                        <td className="py-1 px-6 text-xs font-bold text-green-600">{formatCurrency(record.totalprice || 0)}</td>
                        <td className="py-1 px-6 text-xs">
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => openViewDialog(record)} className="h-8 w-8 p-0 hover:bg-green-100 border-green-200">
                              <Eye className="h-4 w-4 text-green-500" />
                            </Button>
                            {isAdmin(userRole) && (
                              <>
                                <Button variant="outline" size="sm" onClick={() => openEditDialog(record)} className="h-8 w-8 p-0 hover:bg-yellow-100 border-white">
                                  <Edit className="h-4 w-4 text-orange-500" />
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => openSingleDeleteConfirm(record)} className="h-8 w-8 p-0 hover:bg-red-100 border-white">
                                  <Trash2 className="h-4 w-4 text-red-500" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between p-4 border-t bg-gray-50">
                <div className="text-sm text-muted-foreground">{filteredOfftake.length} records - Page {pagination.page} of {pagination.totalPages}</div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!pagination.hasPrev} onClick={() => handlePageChange(pagination.page - 1)}>Previous</Button>
                  <Button variant="outline" size="sm" disabled={!pagination.hasNext} onClick={() => handlePageChange(pagination.page + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* View Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-4xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-slate-900"><Eye className="h-5 w-5 text-green-600" /> Livestock Offtake Details</DialogTitle></DialogHeader>
          {viewingRecord && (
            <div className="space-y-6 py-4 overflow-y-auto max-h-[60vh]">
              <div className="bg-slate-50 rounded-xl p-4">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-semibold text-slate-800 flex items-center gap-2"><Weight className="h-4 w-4" /> Animal Details Table</h3>
                  {isAdmin(userRole) && <Button variant="outline" size="sm" onClick={() => openWeightEditDialog(viewingRecord)}><Edit className="h-4 w-4 mr-2" /> Edit Weights</Button>}
                </div>
                <table className="w-full border border-gray-300 text-sm">
                  <thead>
                    <tr className="bg-blue-100">
                      <th className="border p-2 text-left">Animal #</th>
                      <th className="border p-2 text-left">Live Weight (kg)</th>
                      <th className="border p-2 text-left">Carcass Weight (kg)</th>
                      <th className="border p-2 text-left">Price (Ksh)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewingRecord.liveWeight.map((_, index) => (
                      <tr key={index} className="border-b">
                        <td className="p-2">Animal {index + 1}</td>
                        <td className="p-2">{viewingRecord.liveWeight[index]?.toFixed(1)}</td>
                        <td className="p-2">{viewingRecord.carcassWeight[index]?.toFixed(2) || 'N/A'}</td>
                        <td className="p-2 text-green-700 font-medium">{formatCurrency(viewingRecord.pricePerGoatAndSheep[index] || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter><Button onClick={() => setIsViewDialogOpen(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Form Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader><DialogTitle><Edit className="h-5 w-5 text-blue-600 inline mr-2" />Edit Record</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Date</Label><Input type="date" value={editForm.date} onChange={(e) => setEditForm(p => ({ ...p, date: e.target.value }))} /></div>
              <div><Label>Name</Label><Input value={editForm.farmerName} onChange={(e) => setEditForm(p => ({ ...p, farmerName: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Gender</Label>
                <Select value={editForm.gender} onValueChange={(v) => setEditForm(p => ({ ...p, gender: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Male">Male</SelectItem><SelectItem value="Female">Female</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>ID Number</Label><Input value={editForm.idNumber} onChange={(e) => setEditForm(p => ({ ...p, idNumber: e.target.value }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleEditSubmit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Weights Matrix adjustment dialog */}
      <Dialog open={isWeightEditDialogOpen} onOpenChange={setIsWeightEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader><DialogTitle>Adjust Live & Carcass Metrics</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4 overflow-y-auto max-h-[60vh]">
            <table className="w-full border text-sm">
              <thead>
                <tr className="bg-blue-50">
                  <th className="p-2 text-left">Animal</th>
                  <th className="p-2 text-left">Live Weight (kg)</th>
                  <th className="p-2 text-left">Carcass Weight (kg)</th>
                  <th className="p-2 text-left">Price (KES)</th>
                </tr>
              </thead>
              <tbody>
                {weightEditForm.liveWeights.map((_, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="p-2">#{idx+1}</td>
                    <td className="p-2">
                      <Input type="number" value={weightEditForm.liveWeights[idx] || 0} onChange={(e) => {
                        const next = [...weightEditForm.liveWeights]; next[idx] = parseFloat(e.target.value) || 0;
                        setWeightEditForm(p => ({ ...p, liveWeights: next }));
                      }} />
                    </td>
                    <td className="p-2">
                      <Input type="number" value={weightEditForm.carcassWeights[idx] || 0} onChange={(e) => {
                        const next = [...weightEditForm.carcassWeights]; next[idx] = parseFloat(e.target.value) || 0;
                        setWeightEditForm(p => ({ ...p, carcassWeights: next }));
                      }} />
                    </td>
                    <td className="p-2">
                      <Input type="number" value={weightEditForm.prices[idx] || 0} onChange={(e) => {
                        const next = [...weightEditForm.prices]; next[idx] = parseFloat(e.target.value) || 0;
                        setWeightEditForm(p => ({ ...p, prices: next }));
                      }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsWeightEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleWeightEditSubmit}>Commit Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle><Upload className="h-5 w-5 inline mr-2" />Upload CSV Data</DialogTitle>
            <DialogDescription>Select row-spanning files. Quantities and dates will update active layout filtering automatically.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Input id="csvUpload" type="file" accept=".csv" multiple ref={fileInputRef} onChange={handleFileSelect} disabled={uploadLoading} />
            {uploadLoading && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-slate-500"><span>Streaming batches to cloud storage...</span><span>{uploadProgress.current} / {uploadProgress.total}</span></div>
                <div className="w-full bg-slate-100 h-2 rounded-full"><div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}></div></div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { if(!uploadLoading) setIsUploadDialogOpen(false); }}>Cancel</Button>
            <Button onClick={handleUpload} disabled={uploadLoading || uploadPreview.length === 0}>
              {uploadLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Upload Processing Chunk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete/Purge Confirmations */}
      <Dialog open={isSingleDeleteDialogOpen} onOpenChange={setIsSingleDeleteDialogOpen}>
        <DialogContent className="bg-white rounded-xl">
          <DialogHeader><DialogTitle className="text-red-500">Confirm purge allocation</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSingleDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleSingleDelete} disabled={deleteLoading}>Purge permanently</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent className="bg-white rounded-xl">
          <DialogHeader><DialogTitle className="text-red-500">Confirm bulk removal</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteMultiple} disabled={deleteLoading}>Purge targets</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Text Outbox Notification Trigger */}
      <Dialog open={isBulkSmsDialogOpen} onOpenChange={setIsBulkSmsDialogOpen}>
        <DialogContent className="bg-white rounded-2xl">
          <DialogHeader><DialogTitle>Queue Notification Outbox</DialogTitle></DialogHeader>
          <Textarea rows={4} value={bulkSmsMessage} onChange={e => setBulkSmsMessage(e.target.value)} placeholder="Type communication details explicitly..." />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsBulkSmsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSendBulkSms} disabled={bulkSmsSending}>{bulkSmsSending ? "Processing Broadcast..." : "Commit Outbox Broadcast"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LivestockOfftakePage;