"use client";
import { useState, useRef } from "react";
import { ShoppingBag, Upload, Link2, X } from "lucide-react";

export type ProductItem = {
  id:           string;
  product_name: string;
  image_url:    string | null;
  domain:       string | null;
  price:        number | null;
};

export function CompactProductSet({
  products,
  onRemove,
  onAddFiles,
  onAddByUrl,
}: {
  products:    ProductItem[];
  onRemove:    (id: string) => void;
  onAddFiles:  (files: FileList) => void;
  onAddByUrl?: (url: string, name: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl,  setLinkUrl]  = useState("");
  const [linkName, setLinkName] = useState("");

  function handleAddByUrl() {
    if (!linkUrl.trim()) return;
    onAddByUrl?.(linkUrl.trim(), linkName.trim() || linkUrl.trim());
    setLinkUrl(""); setLinkName(""); setLinkMode(false);
  }

  const CARD: React.CSSProperties = {
    borderRadius: 10,
    border: "1px solid #F1F5F9",
    background: "#FAFAFA",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: 5,
    position: "relative",
    width: 140,
    flexShrink: 0,
  };

  return (
    <div data-testid="product-set">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div>
          <p style={{margin:0,fontSize:"11px",fontWeight:800,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>
            Product Set
          </p>
          <p style={{margin:"2px 0 0",fontSize:"11px",color:"#94A3B8"}}>
            {products.length} product{products.length!==1?"s":""} selected
          </p>
        </div>
        <a href="/app/products"
          style={{padding:"4px 10px",borderRadius:6,border:"1px solid #E5E7EB",background:"#FAFAFA",fontSize:"10px",fontWeight:600,color:"#64748B",textDecoration:"none"}}>
          Change products
        </a>
      </div>

      {/* Horizontal card row */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"stretch"}}>

        {/* Product cards */}
        {products.map(p => (
          <div key={p.id} data-testid="product-set-item" style={CARD}>
            {/* Remove button */}
            <button type="button" onClick={() => onRemove(p.id)}
              title="Remove"
              style={{position:"absolute",top:5,right:5,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,0.08)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1}}>
              <X style={{width:9,height:9,color:"#64748B"}}/>
            </button>

            {/* Thumbnail */}
            <div style={{width:"100%",aspectRatio:"1/1",borderRadius:7,overflow:"hidden",border:"1px solid #E5E7EB",background:"#F1F5F9",flexShrink:0}}>
              {p.image_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={p.image_url} alt={p.product_name}
                    style={{width:"100%",height:"100%",objectFit:"cover"}}
                    onError={e=>{(e.currentTarget.parentElement as HTMLDivElement).style.display="none";}}/>
                : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <ShoppingBag style={{width:16,height:16,color:"#D1D5DB"}}/>
                  </div>}
            </div>

            {/* Name */}
            <p style={{
              margin:0,fontSize:"11px",fontWeight:600,color:"#0F172A",
              overflow:"hidden",display:"-webkit-box",
              WebkitLineClamp:2,WebkitBoxOrient:"vertical" as const,
              lineHeight:1.3,paddingRight:12,
            }}>
              {p.product_name}
            </p>

            {/* Platform */}
            {p.domain && (
              <p style={{margin:0,fontSize:"10px",color:"#94A3B8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {p.domain.replace(/^www\./,"").split(".")[0].toUpperCase()}
              </p>
            )}
          </div>
        ))}

        {/* Add / Paste controls — same height as product cards */}
        {!linkMode ? (
          <>
            <button type="button" data-testid="add-product-button"
              onClick={() => fileRef.current?.click()}
              style={{...CARD,width:110,alignItems:"center",justifyContent:"center",border:"1.5px dashed #D1D5DB",background:"#FAFAFA",cursor:"pointer",gap:6,minHeight:100}}>
              <Upload style={{width:14,height:14,color:"#94A3B8"}}/>
              <span style={{fontSize:"10px",fontWeight:600,color:"#64748B",textAlign:"center"}}>Add product</span>
            </button>
            <button type="button" data-testid="paste-product-link-button"
              onClick={() => setLinkMode(true)}
              style={{...CARD,width:110,alignItems:"center",justifyContent:"center",border:"1.5px dashed #D1D5DB",background:"#FAFAFA",cursor:"pointer",gap:6,minHeight:100}}>
              <Link2 style={{width:14,height:14,color:"#94A3B8"}}/>
              <span style={{fontSize:"10px",fontWeight:600,color:"#64748B",textAlign:"center"}}>Paste link</span>
            </button>
          </>
        ) : (
          <div style={{flex:1,minWidth:220,display:"flex",flexDirection:"column",gap:6,padding:"8px 0"}}>
            <input type="url" value={linkUrl} onChange={e=>setLinkUrl(e.target.value)}
              placeholder="Product URL" autoFocus
              onKeyDown={e => { if (e.key==="Enter") handleAddByUrl(); }}
              style={{borderRadius:8,border:"1px solid #E5E7EB",padding:"7px 10px",fontSize:"12px",outline:"none",color:"#374151"}}/>
            <input type="text" value={linkName} onChange={e=>setLinkName(e.target.value)}
              placeholder="Product name (optional)"
              style={{borderRadius:8,border:"1px solid #E5E7EB",padding:"7px 10px",fontSize:"12px",outline:"none",color:"#374151"}}/>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button type="button"
                onClick={()=>{setLinkMode(false);setLinkUrl("");setLinkName("");}}
                style={{fontSize:"10px",color:"#94A3B8",background:"none",border:"none",cursor:"pointer",fontWeight:500,padding:0}}>
                ← Back
              </button>
              <button type="button" onClick={handleAddByUrl} disabled={!linkUrl.trim()}
                style={{flex:1,padding:"6px",borderRadius:7,border:"none",
                  background:linkUrl.trim()?"#7C3AED":"#E5E7EB",
                  color:linkUrl.trim()?"#fff":"#9CA3AF",
                  fontSize:"10px",fontWeight:700,cursor:linkUrl.trim()?"pointer":"not-allowed"}}>
                Add
              </button>
            </div>
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
        onChange={e => e.target.files?.length && onAddFiles(e.target.files)}/>
    </div>
  );
}
