"""生成一批中文演示课件（仅用于本地验收，不进入产品逻辑）。

运行：python scripts/make_fixtures.py
输出：tests/fixtures/*.pptx / 课堂资料包.zip / 损坏的课件.pptx
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import random

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

INK = RGBColor(0x1F, 0x2A, 0x24)
GREEN = RGBColor(0x2F, 0x6B, 0x4F)
MUTED = RGBColor(0x7A, 0x83, 0x7C)


def add_text(slide, left, top, width, height, lines, size=18, color=INK, bold=False):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    tf.clear()
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.space_after = Pt(8)
        p.level = 0
        for run in p.runs:
            run.font.size = Pt(size)
            run.font.color.rgb = color
            run.font.bold = bold
            run.font.name = "Microsoft YaHei"
    return box


def build_deck(filename, deck_title, slides):
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    for index, (title, bullets) in enumerate(slides):
        slide = prs.slides.add_slide(blank)
        # 顶部色条，纯本地演示文件，无产品含义
        bar = slide.shapes.add_shape(1, Inches(0), Inches(0), Inches(13.333), Inches(0.12))
        bar.fill.solid()
        bar.fill.fore_color.rgb = GREEN
        bar.line.fill.background()

        add_text(slide, 0.8, 0.45, 11.8, 0.7, [deck_title], size=12, color=MUTED)
        add_text(slide, 0.8, 1.05, 11.8, 0.9, [title], size=30, color=GREEN, bold=True)
        body = [f"• {line}" for line in bullets]
        add_text(slide, 0.95, 2.15, 11.6, 4.6, body, size=19)
        add_text(slide, 0.8, 6.95, 8, 0.3, [f"预防医学 · 课堂讲义 · {index + 1}"], size=10, color=MUTED)
    path = OUT / filename
    prs.save(path)
    return path


DECKS = [
    (
        "01-流行病学概述.pptx",
        "预防医学｜流行病学",
        [
            (
                "第一章 流行病学",
                [
                    "流行病学是预防医学的重要分支，也是临床研究和公共卫生决策的方法学基础。",
                    "本章重点：基本概念、常用指标、研究设计、偏倚控制。",
                ],
            ),
            (
                "流行病学的定义",
                [
                    "流行病学是研究人群中疾病与健康状况的分布及其影响因素，并研究防制疾病及促进健康的策略和措施的科学。",
                    "定义中的三个关键词：人群、分布、影响因素与干预措施。",
                    "研究对象是人群，而不仅是临床个体。",
                    "重点：掌握流行病学定义的完整表述。",
                ],
            ),
            (
                "常用疾病频率指标",
                [
                    "发病率 = 一定期间内新发病例数 ÷ 同期暴露人口数 × K。",
                    "患病率 = 某时点现患病例数 ÷ 调查人口数 × K。",
                    "死亡率与病死率不同：病死率反映疾病的严重程度。",
                    "注意：发病率强调新发，患病率强调现患，两者不可混用。",
                ],
            ),
            (
                "疾病的三间分布",
                [
                    "疾病分布从时间、地区、人群三个维度描述。",
                    "时间分布包括短期波动、季节性、周期性、长期趋势。",
                    "地区分布可表现为地方性、外来性与高发区。",
                    "人群分布关注年龄、性别、职业、民族等特征。",
                ],
            ),
            (
                "描述性研究",
                [
                    "现况研究是在特定时点调查人群中疾病或健康状态及其影响因素的分布。",
                    "抽样方法包括单纯随机抽样、系统抽样、分层抽样、整群抽样和多级抽样。",
                    "现况研究不能直接判断因果联系，只能提出病因假设。",
                    "例如：某市 2024 年居民高血压患病率调查属于现况研究。",
                ],
            ),
            (
                "病例对照研究",
                [
                    "病例对照研究选择一组病例和一组对照，回顾性比较既往暴露因素。",
                    "常用效应指标为比值比（OR）。",
                    "优点：省时、省力、适合罕见病；缺点：易发生回忆偏倚，不能直接计算发病率。",
                    "案例：研究吸烟与肺癌的关系，选择肺癌患者为病例组、非肺癌患者为对照组。",
                ],
            ),
            (
                "队列研究",
                [
                    "队列研究按暴露与否分组，前瞻性观察结局发生情况，可计算发病率。",
                    "常用效应指标为相对危险度（RR）和归因危险度（AR）。",
                    "考点：队列研究论证因果关系的能力强于病例对照研究。",
                    "注意：失访偏倚是队列研究的重要偏倚来源。",
                ],
            ),
            (
                "偏倚及其控制",
                [
                    "选择偏倚：研究对象的选择不具代表性，如入院率偏倚。",
                    "信息偏倚：测量或回忆过程中产生的系统误差，如回忆偏倚。",
                    "混杂偏倚：外部因素同时与暴露和结局相关，如年龄、吸烟。",
                    "控制方法：随机化、限制、匹配、分层分析、多因素分析。",
                    "重点：三种偏倚的识别与举例是考试高频考点。",
                ],
            ),
        ],
    ),
    (
        "02-传染病预防.pptx",
        "预防医学｜传染病学",
        [
            (
                "第二章 传染病预防",
                ["传染病预防围绕传染源、传播途径、易感人群三个环节展开。"],
            ),
            (
                "传染病流行的三个环节",
                [
                    "传染源是指体内有病原体生长繁殖并能排出病原体的人和动物。",
                    "传播途径包括空气、飞沫、接触、粪口、虫媒、血液等。",
                    "易感人群对某种传染病缺乏特异性免疫力。",
                    "重点：三个环节缺一不可，切断任一环节均可阻断流行。",
                ],
            ),
            (
                "潜伏期与传染期",
                [
                    "潜伏期是从病原体侵入机体到出现临床症状的时间。",
                    "传染期是病人能排出病原体的时期，是决定隔离期限的重要依据。",
                    "注意：不同传染病潜伏期不同，检疫期限通常按最长潜伏期确定。",
                ],
            ),
            (
                "预防措施",
                [
                    "控制传染源：早发现、早诊断、早报告、早隔离、早治疗。",
                    "切断传播途径：消毒、灭蚊、改善饮水与卫生条件。",
                    "保护易感人群：预防接种、药物预防、个人防护。",
                    "例如：新冠疫情期间戴口罩、通风属于切断呼吸道传播途径。",
                ],
            ),
            (
                "计划免疫",
                [
                    "计划免疫是根据疫情监测和人群免疫状况，按规定的免疫程序进行预防接种。",
                    "我国免疫规划疫苗包括乙肝疫苗、卡介苗、脊灰疫苗、百白破疫苗等。",
                    "考点：疫苗可预防疾病与对应疫苗的匹配。",
                ],
            ),
            (
                "消毒与隔离",
                [
                    "消毒是杀灭或清除传播媒介上的病原微生物。",
                    "隔离是防止病原体从病人或病原携带者传播给他人的措施。",
                    "注意：终末消毒针对病人离开后的疫源地。",
                ],
            ),
        ],
    ),
    (
        "03-环境卫生.pptx",
        "预防医学｜环境卫生学",
        [
            ("第三章 环境卫生", ["环境与健康关系密切，本章关注空气、水、土壤与地方病。"]),
            (
                "环境污染与健康",
                [
                    "环境污染是指人类活动使环境质量下降，影响人体健康的现象。",
                    "环境污染物可通过呼吸道、消化道、皮肤进入人体。",
                    "重点：剂量-效应关系是环境毒理学的重要概念。",
                ],
            ),
            (
                "大气污染",
                [
                    "主要污染物包括颗粒物（PM2.5、PM10）、二氧化硫、氮氧化物、臭氧。",
                    "PM2.5 可深入肺泡，与呼吸系统疾病和心血管疾病相关。",
                    "考点：光化学烟雾由氮氧化物和挥发性有机物在紫外线作用下形成。",
                    "例如：伦敦烟雾事件主要由燃煤产生的烟尘和二氧化硫引起。",
                ],
            ),
            (
                "饮用水卫生",
                [
                    "生活饮用水卫生标准包括微生物、毒理、感官性状和一般化学指标。",
                    "氯化消毒是常用饮用水消毒方法，需注意消毒副产物。",
                    "注意：介水传染病包括霍乱、伤寒、痢疾等。",
                ],
            ),
            (
                "土壤与地方病",
                [
                    "土壤污染可导致重金属在农作物中富集，进而危害人体。",
                    "碘缺乏病可通过食盐加碘预防。",
                    "地方性氟中毒与饮用水中氟含量过高有关。",
                    "重点：地方病与特定地理环境中的元素分布相关。",
                ],
            ),
        ],
    ),
    (
        "04-营养与食品卫生.pptx",
        "预防医学｜营养与食品卫生学",
        [
            ("第四章 营养与食品卫生", ["合理营养是健康的基础，食品安全是公共卫生的重要内容。"]),
            (
                "营养素与能量",
                [
                    "人体必需营养素包括蛋白质、脂类、碳水化合物、矿物质、维生素和水。",
                    "三大产能营养素是蛋白质、脂类和碳水化合物。",
                    "每克蛋白质和碳水化合物约产生 4 kcal，每克脂肪约产生 9 kcal。",
                    "重点：能量需要量由基础代谢、体力活动和食物热效应构成。",
                ],
            ),
            (
                "蛋白质",
                [
                    "蛋白质由氨基酸组成，必需氨基酸人体不能合成或合成不足。",
                    "优质蛋白质主要来自动物性食物和大豆。",
                    "蛋白质营养不良可导致水肿型或消瘦型营养不良。",
                    "考点：蛋白质互补作用可提高食物蛋白质营养价值。",
                ],
            ),
            (
                "维生素",
                [
                    "维生素分为脂溶性和水溶性两类。",
                    "维生素 A 缺乏可导致夜盲症，维生素 D 缺乏与佝偻病相关。",
                    "维生素 C 缺乏引起坏血病，参与胶原蛋白合成。",
                    "例如：远航船员因缺乏新鲜蔬果发生坏血病。",
                ],
            ),
            (
                "膳食指南",
                [
                    "中国居民膳食指南强调食物多样、谷类为主。",
                    "推荐每天摄入 12 种以上食物，每周 25 种以上。",
                    "注意：控盐、控油、控糖是慢性病预防的重要措施。",
                ],
            ),
        ],
    ),
    (
        "05-职业卫生.pptx",
        "预防医学｜职业卫生与职业医学",
        [
            ("第五章 职业卫生", ["职业有害因素可导致职业病与工作相关疾病，预防为主。"]),
            (
                "职业性有害因素",
                [
                    "职业性有害因素分为化学性、物理性、生物性和劳动过程相关因素。",
                    "职业病是指劳动者在职业活动中接触有害因素而引起的特定疾病。",
                    "重点：职业病具有法定性，需列入国家职业病目录。",
                ],
            ),
            (
                "生产性粉尘",
                [
                    "生产性粉尘可导致尘肺病，矽肺是最常见、危害最严重的一种。",
                    "粉尘危害程度与粉尘浓度、分散度、游离二氧化硅含量和接触时间有关。",
                    "预防八字方针：革、水、密、风、护、管、教、查。",
                    "例如：煤矿工人长期吸入含游离二氧化硅粉尘可发生矽肺。",
                ],
            ),
            (
                "职业噪声",
                [
                    "长期接触高强度噪声可导致职业性噪声聋。",
                    "噪声危害早期表现为暂时性听阈位移，长期可发展为永久性听阈位移。",
                    "注意：佩戴耳塞、耳罩属于个体防护措施。",
                ],
            ),
            (
                "职业中毒",
                [
                    "铅、汞、苯等是常见职业性毒物。",
                    "慢性苯中毒可导致造血系统损害，甚至白血病。",
                    "考点：职业中毒的急救原则是迅速脱离现场、清除毒物、对症支持。",
                ],
            ),
            (
                "职业健康监护",
                [
                    "职业健康监护包括上岗前、在岗期间、离岗时和应急健康检查。",
                    "其目的是早期发现职业禁忌证和职业健康损害。",
                    "重点：职业健康检查不能替代职业病诊断。",
                ],
            ),
        ],
    ),
]


for filename, title, slides in DECKS:
    path = build_deck(filename, title, slides)
    print(f"created {path.relative_to(ROOT)}")

# 损坏的 pptx：单个文件失败，不影响同批其他文件
(OUT / "损坏的课件.pptx").write_bytes(b"this is not a real pptx file\n" + bytes(random.randrange(256) for _ in range(512)))

# 含两个可处理课件 + 一个不支持文件 + 目录的 zip
zip_path = OUT / "课堂资料包.zip"
with ZipFile(zip_path, "w", ZIP_DEFLATED) as zf:
    for name in ["02-传染病预防.pptx", "04-营养与食品卫生.pptx"]:
        zf.write(OUT / name, f"预防医学资料/{name}")
    zf.writestr("预防医学资料/说明.txt", "演示用资料包，txt 会被跳过。")
print(f"created {zip_path.relative_to(ROOT)}")

# 最小可解析 PDF（ASCII，用于验证 pdfjs 解析链路）
objects = []
pdf = bytearray()
pdf += b"%PDF-1.4\n"
def add_obj(body: bytes):
    objects.append(body)
    return len(objects)
add_obj(b"<< /Type /Catalog /Pages 2 0 R >>")
add_obj(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
add_obj(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
text = b"BT /F1 20 Tf 72 720 Td (Epidemiology and Preventive Medicine) Tj 0 -32 Td (Definition: the study of the distribution and determinants of health states.) Tj ET"
add_obj(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
add_obj(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
offsets = [0]
for i, body in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
xref_pos = len(pdf)
pdf += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode()
for off in offsets[1:]:
    pdf += f"{off:010d} 00000 n \n".encode()
pdf += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
(OUT / "英文示例-流行病学.pdf").write_bytes(pdf)
print("created tests/fixtures/英文示例-流行病学.pdf")
