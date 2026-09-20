import { useState } from "react";
import { Alert, App, Button, Checkbox, Input, Modal, Select, Space } from "antd";
import { annotateMaterial, localVideoUrl, type LocalVideo, type MaterialAnnotation } from "@/services/local-materials";

export default function MaterialAnnotationEditor({ item, close, saved }: { item: LocalVideo; close: () => void; saved: () => void }) {
    const { message } = App.useApp();
    const [value, setValue] = useState<MaterialAnnotation>(item.annotation ?? { summary: "", parts: [], actions: [], tags: [], shot: "", scene: "", colors: [], warnings: [], generic: false, needsReview: false, userNotes: item.notes ?? "" });
    const [busy, setBusy] = useState(false), [proposed, setProposed] = useState(false);
    async function save() {
        setBusy(true);
        try { await annotateMaterial(item.id, { revision: item.revision, annotation: { ...value, needsReview: false } }); message.success("标注已确认，正在重建索引"); saved(); close(); }
        catch (e) { message.error(e instanceof Error ? e.message : "保存失败"); }
        finally { setBusy(false); }
    }
    return <Modal open title={`标注：${item.fileName}`} width={850} onCancel={close} onOk={() => void save()} confirmLoading={busy} okText="确认标注并索引" okButtonProps={{ disabled: !value.summary.trim() || !item.duration }}>
        <div className="flex flex-col gap-3">
            <video src={localVideoUrl(item.id)} controls className="max-h-52 w-full" />
            {!item.duration && <Alert type="warning" title="请先执行素材分析，读取媒体信息后才能索引" />}
            {item.proposedAnnotation && <Alert type="info" title="AI 新分析待确认，现有人工标注尚未覆盖" action={<Button onClick={() => setProposed(true)}>查看新分析</Button>} />}
            <label>画面简介<Input.TextArea value={value.summary} rows={3} maxLength={2000} onChange={(e) => setValue({ ...value, summary: e.target.value })} /></label>
            <label>人工备注<Input.TextArea value={value.userNotes} rows={2} maxLength={500} onChange={(e) => setValue({ ...value, userNotes: e.target.value })} placeholder="产品型号、卖点、颜色等文字信息，保存后随标注一起参与匹配" /></label>
            {([['parts','产品部位'],['actions','动作'],['tags','标签'],['colors','可见颜色'],['warnings','画质与场景提示']] as const).map(([key,label]) => <label key={key}>{label}<Select mode="tags" className="w-full" value={value[key]} tokenSeparators={['，', ',']} onChange={(v) => setValue({ ...value, [key]: v })} /></label>)}
            <label>景别与角度<Input value={value.shot} onChange={(e) => setValue({ ...value, shot: e.target.value })} /></label>
            <label>场景<Input value={value.scene} onChange={(e) => setValue({ ...value, scene: e.target.value })} /></label>
            <Checkbox checked={value.generic} onChange={(e) => setValue({ ...value, generic: e.target.checked })}>可作为通用产品展示</Checkbox>
            <Alert type="info" title="仅标注实际看见的内容。确认表示你已检查不清晰、多场景及功能证据问题。" />
        </div>
        <Modal open={proposed} title="重新分析结果（尚未覆盖）" onCancel={() => setProposed(false)} footer={<Space><Button onClick={() => setProposed(false)}>保留当前标注</Button><Button type="primary" onClick={() => { setValue(item.proposedAnnotation!); setProposed(false); }}>采用到编辑框，继续检查</Button></Space>}>
            <p>{item.proposedAnnotation?.summary}</p>
            {item.proposedAnnotation && Object.entries(item.proposedAnnotation).filter(([key]) => key !== "summary").map(([key, val]) => <p key={key}>{({ parts: "部位", actions: "动作", tags: "标签", colors: "颜色", shot: "景别", scene: "场景", warnings: "提示", generic: "通用镜头", needsReview: "待确认" } as Record<string,string>)[key]}：{Array.isArray(val) ? val.join("、") : typeof val === "boolean" ? val ? "是" : "否" : val}</p>)}
        </Modal>
    </Modal>;
}
