const dictionaries = {
    en: {
        common: {
            internal_server_error: 'Internal server error',
            active_company_required: 'Active company required',
            insufficient_permissions: 'Insufficient permissions',
            company_not_found: 'Company not found'
        },
        version: {
            version_required: 'Version is required',
            no_version_found: 'No version found'
        },
        subscription: {
            select_paid_plan: 'Please select a paid plan',
            only_card_supported: 'Only card payment is supported',
            plan_missing_integration: 'Plan is missing Paymob integration ID',
            paymob_keys_required: 'PAYMOB_SECRET_KEY and PAYMOB_PUBLIC_KEY are required',
            already_active_until: 'You already have an active {{plan}} subscription until {{expiresAt}}.',
            missing_client_secret: 'Missing client_secret from Paymob response',
            paymob_checkout_created: 'Paymob checkout created successfully',
            webhook_processed: 'Webhook processed',
            missing_company_webhook: 'Missing companyId in webhook payload',
            missing_plan_webhook: 'Missing planId and no pending plan found for company',
            no_pending_subscription: 'No pending subscription found to confirm',
            invalid_post_pay_url: 'Invalid postPayUrl',
            payment_not_successful: 'Payment is not marked as successful',
            subscription_activated: 'Subscription activated successfully',
            notice_grace: 'Your subscription expired. Grace period ends in {{days}} day(s).',
            notice_downgraded: 'Your grace period ended and your subscription has been downgraded to Free.'
        },
        plans: {
            free_name: 'Free',
            free_description: 'Default plan for new companies',
            free_feature_1: 'Up to 3 accounts',
            free_feature_2: 'No chat images, videos, or files',
            free_feature_3: 'No attendance edit or download',
            basic_name: 'Basic',
            basic_description: 'For growing teams',
            basic_feature_1: 'From 3 to 10 members',
            basic_feature_2: 'Chat attachments enabled',
            basic_feature_3: 'Attendance edit and report download',
            pro_name: 'Pro',
            pro_description: 'For larger teams',
            pro_feature_1: 'From 10 to 50 members',
            pro_feature_2: 'Chat attachments enabled',
            pro_feature_3: 'Attendance edit and report download'
        }
    },
    ar: {
        common: {
            internal_server_error: 'حدث خطأ داخلي في الخادم',
            active_company_required: 'يجب تحديد الشركة النشطة',
            insufficient_permissions: 'ليس لديك صلاحية كافية',
            company_not_found: 'الشركة غير موجودة'
        },
        version: {
            version_required: 'الإصدار مطلوب',
            no_version_found: 'لا يوجد إصدار محفوظ'
        },
        subscription: {
            select_paid_plan: 'يرجى اختيار باقة مدفوعة',
            only_card_supported: 'طريقة الدفع المتاحة حاليًا هي البطاقة فقط',
            plan_missing_integration: 'معرّف Paymob الخاص بالباقة غير متوفر',
            paymob_keys_required: 'مفاتيح Paymob غير مكتملة في إعدادات الخادم',
            already_active_until: 'لديك بالفعل باقة {{plan}} نشطة حتى {{expiresAt}}.',
            missing_client_secret: 'لم يتم استلام client_secret من Paymob',
            paymob_checkout_created: 'تم إنشاء رابط الدفع بنجاح',
            webhook_processed: 'تمت معالجة إشعار الدفع',
            missing_company_webhook: 'لم يتم العثور على معرف الشركة في webhook',
            missing_plan_webhook: 'لم يتم العثور على معرف الباقة في webhook',
            no_pending_subscription: 'لا يوجد اشتراك معلق للتأكيد',
            invalid_post_pay_url: 'رابط postPay غير صالح',
            payment_not_successful: 'عملية الدفع غير مؤكدة كنجاح',
            subscription_activated: 'تم تفعيل الاشتراك بنجاح',
            notice_grace: 'انتهى الاشتراك. فترة السماح تنتهي بعد {{days}} يوم.',
            notice_downgraded: 'انتهت فترة السماح وتم التحويل إلى الباقة المجانية.'
        },
        plans: {
            free_name: 'مجانية',
            free_description: 'الباقة الافتراضية للشركات الجديدة',
            free_feature_1: 'حتى 3 حسابات',
            free_feature_2: 'بدون صور أو فيديو أو ملفات في الشات',
            free_feature_3: 'بدون تعديل أو تحميل الحضور',
            basic_name: 'أساسية',
            basic_description: 'لفِرَق العمل المتوسطة',
            basic_feature_1: 'من 3 إلى 10 أفراد',
            basic_feature_2: 'إتاحة مرفقات الشات',
            basic_feature_3: 'تعديل الحضور وتحميل التقارير',
            pro_name: 'احترافية',
            pro_description: 'لفِرَق العمل الكبيرة',
            pro_feature_1: 'من 10 إلى 50 فرد',
            pro_feature_2: 'إتاحة مرفقات الشات',
            pro_feature_3: 'تعديل الحضور وتحميل التقارير'
        }
    }
};

const rawMessageTranslations = {
    ar: {
        'No images uploaded': 'لم يتم رفع أي صور',
        'Images uploaded successfully': 'تم رفع الصور بنجاح',
        'Failed to upload images': 'فشل في رفع الصور',
        'Image deleted successfully': 'تم حذف الصورة بنجاح',
        'Image not found': 'الصورة غير موجودة',
        'Failed to delete image': 'فشل في حذف الصورة',
        'You are not a member of this company': 'أنت لست عضوًا في هذه الشركة',
        'Access token required': 'رمز الدخول مطلوب',
        'Invalid token': 'رمز الدخول غير صالح',
        'Invalid or expired token': 'رمز الدخول غير صالح أو منتهي',
        'Authentication required': 'تسجيل الدخول مطلوب',
        'Question sent successfully to brofa@absai.dev': 'تم إرسال السؤال بنجاح إلى brofa@absai.dev',
        'Failed to send question': 'فشل في إرسال السؤال',
        'All notifications marked as read': 'تم تحديد كل الإشعارات كمقروءة',
        'Notifications marked as read': 'تم تحديد الإشعارات كمقروءة',
        'Provide body.ids (array of notification ids) or body.all: true': 'يرجى إرسال body.ids (مصفوفة معرفات الإشعارات) أو body.all: true',
        'Notification not found': 'الإشعار غير موجود',
        'Project created successfully': 'تم إنشاء المشروع بنجاح',
        'Assigned users array is required': 'مصفوفة المستخدمين المعيّنين مطلوبة',
        'Project not found': 'المشروع غير موجود',
        'You can only manage projects in your active company': 'يمكنك إدارة مشاريع شركتك النشطة فقط',
        'Assigned users must belong to the active company': 'يجب أن يكون المستخدمون المعيّنون ضمن الشركة النشطة',
        'Some assigned users are invalid': 'بعض المستخدمين المعيّنين غير صالحين',
        'Users assigned to project successfully': 'تم تعيين المستخدمين للمشروع بنجاح',
        'Access denied to this project': 'ليس لديك صلاحية للوصول لهذا المشروع',
        'Status is required': 'الحالة مطلوبة',
        'You can only update projects in your active company': 'يمكنك تحديث مشاريع شركتك النشطة فقط',
        'Project status updated successfully': 'تم تحديث حالة المشروع بنجاح',
        'Company not found': 'الشركة غير موجودة',
        'User not found': 'المستخدم غير موجود',
        'Current password and new password are required': 'كلمة المرور الحالية والجديدة مطلوبتان',
        'Current password is incorrect': 'كلمة المرور الحالية غير صحيحة',
        'Password changed successfully': 'تم تغيير كلمة المرور بنجاح',
        'Valid FCM token is required': 'رمز FCM صالح مطلوب',
        'FCM token registered successfully': 'تم تسجيل رمز FCM بنجاح',
        'FCM token unregistered successfully': 'تم إلغاء تسجيل رمز FCM بنجاح',
        'token and password are required': 'الرمز وكلمة المرور مطلوبان',
        'Password must be at least 6 characters': 'يجب أن تكون كلمة المرور 6 أحرف على الأقل',
        'Invalid invitation token': 'رمز الدعوة غير صالح',
        'Invitation token expired': 'رمز الدعوة منتهي الصلاحية',
        'Invitation accepted successfully. You can now login.': 'تم قبول الدعوة بنجاح. يمكنك تسجيل الدخول الآن.',
        'Profile updated successfully': 'تم تحديث الملف الشخصي بنجاح',
        'Check-in successful': 'تم تسجيل الحضور بنجاح',
        'Check-out successful': 'تم تسجيل الانصراف بنجاح',
        'No open check-in found.': 'لا يوجد حضور مفتوح',
        'Attendance record not found': 'سجل الحضور غير موجود',
        'Invalid checkIn date': 'تاريخ checkIn غير صالح',
        'Invalid checkOut date': 'تاريخ checkOut غير صالح',
        'Invalid status': 'الحالة غير صالحة',
        'checkOut must be after checkIn': 'يجب أن يكون checkOut بعد checkIn',
        'Attendance updated successfully': 'تم تحديث الحضور بنجاح',
        'Send both month (1–12) and year together, or omit both.': 'أرسل الشهر (1-12) والسنة معًا، أو احذفهما معًا',
        'Month (1–12) and year are required.': 'الشهر (1-12) والسنة مطلوبان',
        'Invalid format. Use xlsx or csv.': 'صيغة غير صالحة. استخدم xlsx أو csv',
        'Server is running': 'الخادم يعمل',
        'ABSAI Ticket Management API is running!': 'واجهة ABSAI Ticket Management API تعمل',
        'Internal server error': 'حدث خطأ داخلي في الخادم',
        'Active company required': 'يجب تحديد الشركة النشطة',
        'Insufficient permissions': 'ليس لديك صلاحية كافية',
        'No version found': 'لا يوجد إصدار محفوظ',
        'Version is required': 'الإصدار مطلوب'
    }
};

const normalizeLang = (value) => {
    const raw = String(value || 'en').toLowerCase();
    if (raw.startsWith('ar')) return 'ar';
    return 'en';
};

const interpolate = (template, vars = {}) => {
    let result = template;
    Object.entries(vars).forEach(([key, value]) => {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    });
    return result;
};

const t = (lang, key, vars = {}) => {
    const normalized = normalizeLang(lang);
    const [scope, name] = key.split('.');
    const enValue = dictionaries.en?.[scope]?.[name];
    const targetValue = dictionaries[normalized]?.[scope]?.[name] || enValue;
    if (!targetValue) return key;
    return interpolate(targetValue, vars);
};

const localizePlan = (plan, lang) => {
    const normalized = normalizeLang(lang);
    const id = plan.id;
    const localizedName = dictionaries[normalized]?.plans?.[`${id}_name`] || plan.name;
    const localizedDescription = dictionaries[normalized]?.plans?.[`${id}_description`] || plan.description;
    const localizedFeatures = (plan.features || []).map((feature, index) =>
        dictionaries[normalized]?.plans?.[`${id}_feature_${index + 1}`] || feature
    );

    return {
        ...plan,
        name: localizedName,
        description: localizedDescription,
        features: localizedFeatures
    };
};

const translateRawMessage = (lang, message) => {
    const normalized = normalizeLang(lang);
    if (normalized === 'en') return message;
    const text = String(message || '');
    const mapped = rawMessageTranslations[normalized]?.[text];
    if (mapped) return mapped;

    if (text.startsWith('Missing required fields: ')) {
        const fields = text.replace('Missing required fields: ', '');
        return `الحقول المطلوبة غير مكتملة: ${fields}`;
    }
    if (text.startsWith('Invalid role. Allowed roles: ')) {
        const roles = text.replace('Invalid role. Allowed roles: ', '');
        return `الدور غير صالح. الأدوار المسموح بها: ${roles}`;
    }
    if (text.startsWith('Current ') && text.includes(' plan allows up to ')) {
        return text
            .replace('Current ', 'الخطة الحالية ')
            .replace(' plan allows up to ', ' تسمح حتى ')
            .replace(' accounts.', ' حسابات.');
    }
    if (text === 'Active company required. Log in with a company or switch company first.') {
        return 'يجب تحديد الشركة النشطة. سجل الدخول بشركة أو غيّر الشركة أولاً';
    }
    if (text === 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.') {
        return 'يجب تحديد الشركة النشطة. سجل الدخول بشركة أو أنشئ شركة أو استخدم POST /api/auth/switch-company';
    }
    return message;
};

module.exports = {
    t,
    normalizeLang,
    localizePlan,
    translateRawMessage
};
