import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Select } from "antd";
import { PackageOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Product } from "@/types/product";

function ProductThumbnail({ product, compact = false }: { product: Product; compact?: boolean }) {
    const src = product.resultImage?.thumbnailUrl || product.resultImage?.url;
    const [failed, setFailed] = useState(false);

    useEffect(() => setFailed(false), [src]);

    return (
        <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded border border-border bg-muted", compact ? "size-7" : "size-11")}>
            {src && !failed
                ? <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-contain" onError={() => setFailed(true)} />
                : <PackageOpen className={cn("text-muted-foreground", compact ? "size-3.5" : "size-5")} />}
        </span>
    );
}

function ProductOption({ product, compact = false }: { product: Product; compact?: boolean }) {
    const description = [product.brand, product.productType].filter(Boolean).join(" · ");
    return (
        <span className={cn("flex min-w-0 items-center", compact ? "h-8 gap-2" : "min-h-12 gap-3 py-1")}>
            <ProductThumbnail product={product} compact={compact} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{product.name}</span>
                {!compact && description ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span> : null}
            </span>
        </span>
    );
}

export function ProductSelect({ products, value, onChange, placeholder = "选择已生成四视角主图的商品", notFoundContent, className, loading = false }: { products: Product[]; value?: string; onChange: (value: string) => void; placeholder?: string; notFoundContent?: ReactNode; className?: string; loading?: boolean }) {
    const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
    const options = useMemo(() => products.map((product) => ({ value: product.id, label: product.name })), [products]);

    return (
        <Select<string>
            value={value || undefined}
            onChange={onChange}
            className={className}
            size="large"
            loading={loading}
            disabled={loading}
            showSearch
            virtual={false}
            optionFilterProp="label"
            placeholder={placeholder}
            notFoundContent={notFoundContent}
            options={options}
            optionRender={(option) => {
                const product = productById.get(String(option.value));
                return product ? <ProductOption product={product} /> : option.label;
            }}
            labelRender={(label) => {
                const product = productById.get(String(label.value));
                return product ? <ProductOption product={product} compact /> : label.label;
            }}
        />
    );
}
