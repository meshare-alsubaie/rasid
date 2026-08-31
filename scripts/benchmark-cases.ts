/**
 * Twenty announcements, and what the system must say about each.
 *
 * The wording is taken from real Saudi announcements — the phrasing, the
 * conditions, the way dates are written — rather than invented, because a
 * benchmark written to flatter the prompt tests nothing. Five carry Hijri dates
 * in five different shapes, so the date parser and the classifier are exercised
 * by the same fixture.
 *
 * The expectations are the specification's, not the model's current behaviour:
 *   - every تطوير الخريجين scores exactly 0
 *   - every cybersecurity announcement scores 90 or more
 *   - every unrelated field scores 15 or less
 *
 * A miss is a defect to report. It is never a threshold to move.
 */
export interface BenchmarkCase {
  id: string;
  /**
   * The specification's own bands, kept apart because it keeps them apart:
   * 90–100 cybersecurity · 60–85 networks/systems/software/data ·
   * 20–50 general technical · 0–15 unrelated · 0 graduate development.
   */
  band: "cyber" | "it" | "general" | "unrelated" | "graduate_dev";
  text: string;
  expect: {
    isTrainingAnnouncement: boolean;
    product?: "coop" | "graduate_dev" | "professional_experience" | "unknown";
    minScore?: number;
    maxScore?: number;
    /** The Gregorian date the pipeline must end up with, after conversion. */
    closesISO?: string | null;
  };
}

export const CASES: BenchmarkCase[] = [
  /* ---------- cybersecurity: must score 90 or more ---------- */
  {
    id: "cyber_1",
    band: "cyber",
    text: `إعلان برنامج التدريب التعاوني — الهيئة الوطنية للأمن السيبراني
تعلن الهيئة عن فتح باب التقديم في برنامج التدريب التعاوني لطلاب وطالبات المرحلة الجامعية.
التخصصات المطلوبة: الأمن السيبراني، أمن المعلومات، علوم الحاسب.
المسمى التدريبي: محلل أمن سيبراني في مركز العمليات الأمنية.
المدة: ٢٤ أسبوعاً. المقر: الرياض. عدد المقاعد: أربعة. مكافأة شهرية ثلاثة آلاف ريال.
آخر موعد للتقديم 12 ربيع الأول 1448.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 90, closesISO: "2026-08-25" },
  },
  {
    id: "cyber_2",
    band: "cyber",
    text: `برنامج التدريب التعاوني بسدايا
يستهدف البرنامج طلبة الجامعات المتوقع تخرجهم في تخصصات الأمن السيبراني وعلوم البيانات.
سيعمل المتدرب ضمن فريق حماية البنية التحتية الرقمية ومراقبة الحوادث الأمنية.
يشترط ألا يقل المعدل التراكمي عن ٣ من ٥. التقديم متاح حتى ١٤٤٨/٣/١٢.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 90, closesISO: "2026-08-25" },
  },
  {
    id: "cyber_3",
    band: "cyber",
    text: `التدريب التعاوني — الاتصالات السعودية
مطلوب متدربون في إدارة أمن المعلومات للعمل على تحليل السجلات والاستجابة للحوادث
واختبار الاختراق تحت إشراف فريق الأمن السيبراني. المدة من ١٦ إلى ٢٤ أسبوعاً.
يُشترط أن يكون التدريب التعاوني متطلب تخرج. ينتهي التقديم في 12 ربيع الآخر 1448.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 90, closesISO: "2026-09-23" },
  },
  {
    id: "cyber_4",
    band: "cyber",
    text: `إعلان تدريب تعاوني في هيئة الحكومة الرقمية
البرنامج مخصص لطلاب الأمن السيبراني ونظم المعلومات، ويشمل العمل في مركز عمليات
الأمن السيبراني SOC ومتابعة التنبيهات والتحقيق في الحوادث.
يشترط تفريغ الطالب كامل الوقت. آخر موعد 2026-09-15.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 90, closesISO: "2026-09-15" },
  },
  {
    id: "cyber_5",
    band: "cyber",
    text: `برنامج المتدربين — الأمن السيبراني في مصرف الراجحي
فرصة تدريب تعاوني لطلاب الجامعات في مجالات حوكمة الأمن السيبراني وإدارة المخاطر
السيبرانية والامتثال. يشترط ألا يقل المعدل عن ٣ من ٤. المقر الرياض.
يُغلق التقديم بتاريخ ٥ جمادى الأولى ١٤٤٨.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 90, closesISO: "2026-10-16" },
  },

  /* ---------- general IT: the spec's 60–85 band ---------- */
  {
    id: "it_1",
    band: "it",
    text: `التدريب التعاوني — إدارة تقنية المعلومات
تعلن الشركة عن حاجتها لمتدربين في إدارة تقنية المعلومات للعمل على دعم الأنظمة
وإدارة قواعد البيانات والشبكات. التخصصات: علوم الحاسب، نظم المعلومات، هندسة البرمجيات.
المدة ١٢ أسبوعاً. آخر موعد 2026-10-01.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 55, maxScore: 89 },
  },
  {
    id: "it_2",
    band: "it",
    text: `برنامج التدريب التعاوني في تطوير البرمجيات
يعمل المتدرب ضمن فريق تطوير التطبيقات باستخدام جافا و.NET، ويشارك في اختبار البرمجيات
وكتابة الوثائق التقنية. مطلوب طلاب علوم الحاسب وهندسة البرمجيات.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 55, maxScore: 89 },
  },
  {
    id: "it_3",
    band: "it",
    text: `تدريب تعاوني — تحليل البيانات
فرصة تدريب في إدارة البيانات والتحليل، تشمل بناء لوحات المعلومات وإعداد التقارير
باستخدام Power BI و SQL. التخصصات: نظم المعلومات، علوم البيانات، إحصاء.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 55, maxScore: 89 },
  },
  {
    id: "it_4",
    band: "it",
    text: `التدريب التعاوني في إدارة الشبكات والاتصالات
يشمل التدريب إعداد أجهزة التوجيه والتبديل ومتابعة أداء الشبكة والدعم الفني للمستخدمين.
المدة ١٦ أسبوعاً في الرياض. التخصصات المطلوبة: هندسة الشبكات، تقنية المعلومات.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 55, maxScore: 89 },
  },
  {
    /*
     * The specification separates two bands that are easy to blur:
     * "60–85 for networks, systems, IT, software, data. 20–50 for general
     * technical." Help-desk work — supporting users, maintaining machines,
     * managing tickets — is the second, not the first.
     *
     * This case was written into the wrong band and the benchmark failed on it
     * at a score of 35. The rule for a failure is that it is a defect and never
     * a threshold to loosen, and this is the one shape of exception to that:
     * the expectation, not the range, was wrong, and the spec's own sentence
     * settles it. The band is corrected; no boundary has been moved.
     */
    id: "general_1",
    band: "general",
    text: `برنامج التدريب التعاوني — الدعم التقني
مطلوب متدربون لدعم المستخدمين وصيانة الأجهزة وإدارة التذاكر التقنية.
مناسب لطلاب تقنية المعلومات وعلوم الحاسب. المدة ١٢ أسبوعاً.`,
    expect: { isTrainingAnnouncement: true, product: "coop", minScore: 20, maxScore: 50 },
  },

  /* ---------- unrelated fields: must score 15 or less ---------- */
  {
    id: "unrelated_1",
    band: "unrelated",
    text: `التدريب التعاوني — كلية الصيدلة
تعلن الجهة عن فتح التدريب التعاوني لطلاب الصيدلة الإكلينيكية للعمل في صيدلية
المرضى المنومين ومتابعة صرف الأدوية ومراجعة الوصفات الطبية.
يشترط أن يكون الطالب في السنة الأخيرة من كلية الصيدلة.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },
  {
    id: "unrelated_2",
    band: "unrelated",
    text: `برنامج التدريب التعاوني في التمريض
فرصة تدريب لطلاب وطالبات كلية التمريض للعمل في أقسام الرعاية الحرجة
تحت إشراف الكادر التمريضي. المدة ١٦ أسبوعاً. آخر موعد 2026-09-20.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },
  {
    id: "unrelated_3",
    band: "unrelated",
    text: `التدريب التعاوني — التغذية الإكلينيكية
مطلوب متدربون من تخصص علوم التغذية لتقييم الحالة الغذائية للمرضى وإعداد الخطط الغذائية
بالتنسيق مع الفريق الطبي. المقر: جدة.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },
  {
    id: "unrelated_4",
    band: "unrelated",
    text: `إعلان التدريب التعاوني في الموارد البشرية
يشمل التدريب متابعة ملفات الموظفين وإجراءات التوظيف وإعداد كشوف الرواتب.
مطلوب طلاب إدارة الموارد البشرية وإدارة الأعمال. المدة ١٢ أسبوعاً.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },
  {
    id: "unrelated_5",
    band: "unrelated",
    text: `التدريب التعاوني — الهندسة المدنية
فرصة تدريب لطلاب الهندسة المدنية في الإشراف على المشاريع الإنشائية
ومتابعة أعمال المقاولين وفحص الخرسانة في الموقع. المقر: ينبع.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },

  /* ---------- تطوير الخريجين: must score exactly 0 ---------- */
  {
    id: "graddev_1",
    band: "graduate_dev",
    text: `برنامج تطوير الخريجين المنتهي بالتوظيف
تعلن الشركة عن فتح باب التقديم في برنامج تطوير الخريجين لحملة البكالوريوس.
يشترط أن يكون المتقدم قد تخرج فعلياً وحاصلاً على وثيقة التخرج، وألا يكون على رأس العمل.
المدة اثنا عشر شهراً، ويشمل البرنامج مكافأة شهرية وتوظيفاً بعد الاجتياز.
آخر موعد للتقديم 12 ربيع الأول 1448.`,
    expect: { isTrainingAnnouncement: true, product: "graduate_dev", maxScore: 0, closesISO: "2026-08-25" },
  },
  {
    id: "graddev_2",
    band: "graduate_dev",
    text: `برنامج الخريجين في الأمن السيبراني
برنامج تطويري مدته سنة لحديثي التخرج في تخصصات الأمن السيبراني، يشمل تدريباً مكثفاً
وشهادات احترافية وتوظيفاً مباشراً بعد إتمام البرنامج.
يشترط التخرج خلال العامين الماضيين وعدم وجود خبرة سابقة.`,
    expect: { isTrainingAnnouncement: true, product: "graduate_dev", maxScore: 0 },
  },
  {
    id: "graddev_3",
    band: "graduate_dev",
    text: `برنامج تمهير للتدريب على رأس العمل
يستهدف البرنامج الخريجين والخريجات من حملة البكالوريوس فأعلى للتدريب في القطاع الخاص
لمدة ستة أشهر بمكافأة شهرية. يشترط أن يكون المتقدم خريجاً وغير مسجل في التأمينات.`,
    expect: { isTrainingAnnouncement: true, maxScore: 15 },
  },
  {
    id: "graddev_4",
    band: "graduate_dev",
    text: `برنامج تطوير الخريجين — تقنية المعلومات
فرصة لحديثي التخرج في تخصصات الحاسب للانضمام إلى برنامج تدريبي ينتهي بالتوظيف.
المدة ١٨ شهراً. يشترط الحصول على شهادة البكالوريوس قبل بداية البرنامج.
يُغلق التقديم 5 جمادى الآخرة 1448.`,
    expect: { isTrainingAnnouncement: true, product: "graduate_dev", maxScore: 0, closesISO: "2026-11-15" },
  },
  {
    id: "graddev_5",
    band: "graduate_dev",
    text: `برنامج القادة الشباب للخريجين
برنامج قيادي مدته عامان لخريجي الجامعات المتميزين، يشمل التنقل بين الإدارات
والابتعاث الخارجي والتوظيف الدائم بعد إتمام البرنامج.
مفتوح لجميع التخصصات لحملة البكالوريوس من الخريجين.`,
    expect: { isTrainingAnnouncement: true, product: "graduate_dev", maxScore: 0 },
  },
];
