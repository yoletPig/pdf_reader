"""Prompt 管理 API"""
from fastapi import APIRouter, HTTPException
from app.services.prompt import prompt_manager

router = APIRouter(prefix="/api/prompts", tags=["Prompt管理"])


@router.get("")
async def list_prompts():
    """获取 Prompt 模板列表"""
    templates = prompt_manager.list_templates()
    return {
        "templates": [
            {
                "id": t.id,
                "agent_mode": t.agent_mode,
                "layer": t.layer,
                "name": t.name,
                "content": t.content,
                "version": t.version,
                "is_active": t.is_active,
            }
            for t in templates
        ],
    }


@router.put("/{template_id}")
async def update_prompt(template_id: str, data: dict):
    """更新 Prompt 模板"""
    content = data.get("content", "")
    change_note = data.get("change_note", "")

    template = prompt_manager.update_template(template_id, content, change_note)
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    return {
        "id": template.id,
        "version": template.version,
        "message": "更新成功",
    }


@router.post("/{template_id}/revert")
async def revert_prompt(template_id: str, data: dict):
    """回退 Prompt 版本"""
    target_version = data.get("version", 0)
    template = prompt_manager.revert_template(template_id, target_version)
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在或版本无效")

    return {
        "id": template.id,
        "version": template.version,
        "message": f"已回退到版本 {template.version}",
    }
